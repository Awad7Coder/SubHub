import {
  Controller,
  Post,
  Req,
  Headers,
  HttpCode,
  HttpStatus,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import type{ Request } from 'express';
import Stripe from 'stripe';
import { WebhooksService } from './webhooks.service';
import { SkipThrottle } from '@nestjs/throttler';

/**
 * WHY @ApiExcludeController?
 *
 * The webhook endpoint must NOT appear in your public Swagger docs.
 * It's an internal Stripe-to-server channel, not a client-facing API.
 * Documenting it tells attackers exactly what events you process
 * and what data structure you expect — unnecessary exposure.
 */
@ApiExcludeController()
@SkipThrottle()
@Controller('webhooks')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);
  private readonly stripe: Stripe;
  private readonly webhookSecret: string;

  constructor(
    private readonly webhooksService: WebhooksService,
    private readonly configService: ConfigService,
  ) {
    this.stripe = new Stripe(
      this.configService.getOrThrow<string>('STRIPE_SECRET_KEY'),
      { apiVersion: '2026-02-25.clover' },
    );

    this.webhookSecret = this.configService.getOrThrow<string>(
      'STRIPE_WEBHOOK_SECRET',
    );
  }

  /**
   * POST /api/webhooks/stripe
   *
   * WHY @Req() raw request instead of @Body()?
   *
   * Stripe signature verification (stripe.webhooks.constructEvent) requires
   * the RAW request body bytes — the exact bytes Stripe sent over the wire.
   *
   * NestJS's default JSON parser converts the body to a JavaScript object.
   * Once parsed, you can't recover the original bytes — JSON.stringify()
   * produces different output (different key order, whitespace).
   *
   * Solution: bypass the global JSON parser for this route.
   * In main.ts we register:
   *   app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }))
   * BEFORE app.useGlobalPipes(). This gives us req.body as a Buffer here.
   *
   * WHY @HttpCode(200) instead of default 201?
   * Stripe expects 200 on success. Any 2xx works, but 200 is conventional
   * for webhook acknowledgement (no resource was "created" from our perspective).
   *
   * WHY return immediately after queueing?
   * Stripe has a 30-second webhook timeout. If we do all DB work synchronously,
   * a slow DB query could cause a timeout → Stripe retries → duplicate processing.
   *
   * For heavy operations, consider queueing via BullMQ and returning 200 fast.
   * For our handlers (DB reads/writes, no external calls), synchronous is fine.
   */
  @Post('stripe')
  @HttpCode(HttpStatus.OK)
  async handleStripeWebhook(
    @Req() req: Request,
    @Headers('stripe-signature') signature: string,
  ): Promise<{ received: boolean }> {
    if (!signature) {
      this.logger.warn('Webhook received without stripe-signature header');
      throw new BadRequestException('Missing stripe-signature header');
    }

    let event: Stripe.Event;

    try {
      /**
       * constructEvent does THREE things:
       * 1. Verifies the signature using your webhook secret
       * 2. Checks the timestamp (rejects events older than 5 minutes — replay attack protection)
       * 3. Parses and returns the typed Event object
       *
       * If ANY of these fail, it throws a Stripe.errors.StripeSignatureVerificationError.
       * We catch it and return 400 — tells Stripe "bad request, don't retry".
       */
      event = this.stripe.webhooks.constructEvent(
        req.body as Buffer,
        signature,
        this.webhookSecret,
      );
    } catch (error) {
      this.logger.warn(`Webhook signature verification failed: ${error.message}`);
      throw new BadRequestException(`Webhook signature verification failed`);
    }

    /**
     * WHY check for duplicate events?
     *
     * Stripe guarantees at-least-once delivery — the same event CAN arrive
     * multiple times (network retry, Stripe infrastructure hiccup).
     * event.id is globally unique per event. Storing processed IDs prevents
     * double-charging or double-cancelling on duplicate delivery.
     *
     * We don't implement this here to keep the example clean, but in production
     * you should check a processed_webhook_events table before handling.
     * Your existing Idempotency table could be reused for this.
     */

    try {
      await this.webhooksService.handleEvent(event);
    } catch (error) {
      /**
       * WHY re-throw as 500 (not 400)?
       *
       * A 400 tells Stripe "this event was malformed — stop retrying".
       * A 500 tells Stripe "we had an internal error — please retry later".
       *
       * If our DB is down and we fail to process a legitimate event,
       * we WANT Stripe to retry. So we let the 500 propagate.
       * GlobalExceptionFilter will catch it and return 500.
       */
      this.logger.error(
        `Failed to handle webhook event ${event.type} [${event.id}]: ${error.message}`,
      );
      throw error;
    }

    return { received: true };
  }
}