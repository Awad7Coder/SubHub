import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import {
  PaymentProvider,
  ChargeResult,
  RefundResult,
  PaymentDeclinedException,
  ProviderUnavailableException,
  PaymentConfigurationException,
} from './payment.provider.interface';

@Injectable()
export class StripeProvider implements PaymentProvider {
  readonly name = 'stripe';

  private readonly logger = new Logger(StripeProvider.name);
  private readonly client: Stripe;

  constructor(private readonly configService: ConfigService) {
    const secretKey = this.configService.get<string>('STRIPE_SECRET_KEY');

    if (!secretKey) {
      throw new PaymentConfigurationException(
        'STRIPE_SECRET_KEY is not configured',
      );
    }

    this.client = new Stripe(secretKey, {
      apiVersion: '2026-02-25.clover',
      /**
       * WHY set maxNetworkRetries?
       * The Stripe SDK has built-in retry logic for network errors.
       * Setting this to 2 means Stripe retries transient network failures
       * automatically BEFORE throwing StripeConnectionError to us.
       * Combined with our own circuit breaker, this gives two layers
       * of retry protection for network-level issues.
       *
       * WHY not set this higher (e.g. 5)?
       * Each retry adds latency. BullMQ job timeout would trigger
       * before Stripe finishes retrying. 2 is the sweet spot.
       */
      maxNetworkRetries: 2,
      timeout: 10000, // 10 second timeout per request
    });
  }

  // ─── charge() ─────────────────────────────────────────────────────────

  async charge(params: {
    amount: number;
    currency: string;
    customerId: string;
    invoiceId: string;
    idempotencyKey: string;
  }): Promise<ChargeResult> {
    try {
      this.logger.debug(
        `Charging customer ${params.customerId} — amount: ${params.amount} ${params.currency}`,
      );

      /**
       * WHY PaymentIntent and not Charge directly?
       * Stripe deprecated direct Charge creation in favour of PaymentIntents.
       * PaymentIntents support SCA (Strong Customer Authentication) required
       * in Europe, and give better visibility into payment lifecycle.
       *
       * WHY confirm: true?
       * We pass a stored payment method — no user interaction needed.
       * confirm: true creates AND confirms the intent in one API call.
       * Without it, you'd need a second API call to confirm.
       *
       * WHY off_session: true?
       * Tells Stripe this charge is happening without the customer present
       * (recurring billing, not a checkout session). This affects which
       * SCA exemptions apply and how Stripe handles authentication failures.
       */
      const intent = await this.client.paymentIntents.create(
        {
          amount: Math.round(params.amount * 100), // Stripe uses cents
          currency: params.currency.toLowerCase(),
          customer: params.customerId,
          confirm: true,
          off_session: true,
          /**
           * WHY not pass payment_method here?
           * In a full implementation, you'd store the customer's
           * default payment method ID and pass it here.
           * For SubHub's architecture, the customer's default payment
           * method is managed in Stripe directly (via Customer object).
           * Stripe uses it automatically when payment_method is omitted
           * and the customer has a default_source set.
           */
          metadata: {
            invoiceId: params.invoiceId,
            source: 'subhub-billing',
          },
        },
        {
          /**
           * WHY pass idempotencyKey to Stripe too?
           * Our IdempotencyInterceptor handles HTTP-level deduplication.
           * Stripe's idempotency key handles provider-level deduplication.
           * If our BullMQ worker retries a failed job (not a failed charge,
           * but a failed job — Redis timeout, worker crash), Stripe sees
           * the same key and returns the original result instead of
           * charging again. Two-layer protection.
           */
          idempotencyKey: params.idempotencyKey,
        },
      );

      if (intent.status !== 'succeeded') {
        /**
         * WHY throw here even though Stripe didn't throw?
         * Stripe can return a PaymentIntent with status 'requires_action'
         * (3D Secure needed) or 'requires_payment_method' (card failed
         * silently). These are not exceptions from Stripe's perspective
         * but they ARE failures from ours — the money didn't move.
         */
        throw new PaymentDeclinedException(
          `Payment intent status: ${intent.status}`,
          intent.status,
        );
      }

      this.logger.log(
        `Charge succeeded: ${intent.id} — ${params.amount} ${params.currency}`,
      );

      return {
        success: true,
        transactionId: intent.id,
        amount: intent.amount / 100,
        currency: intent.currency,
        processedAt: new Date(intent.created * 1000),
      };

    } catch (error) {
      // Re-throw our own exceptions unchanged — already translated
      if (
        error instanceof PaymentDeclinedException ||
        error instanceof ProviderUnavailableException ||
        error instanceof PaymentConfigurationException
      ) {
        throw error;
      }

      // ── Translate Stripe errors into domain errors ──────────────────
      // This is the boundary. No Stripe types escape this catch block.

      if (error instanceof Stripe.errors.StripeCardError) {
        /**
         * Card was declined. Stripe provides a decline_code for specifics:
         * 'insufficient_funds', 'expired_card', 'do_not_honor', etc.
         * We surface the code but not the raw Stripe message (too technical).
         */
        throw new PaymentDeclinedException(
          this.humanizeDeclineCode(error.code ?? 'card_declined'),
          error.code,
        );
      }

      if (
        error instanceof Stripe.errors.StripeRateLimitError ||
        error instanceof Stripe.errors.StripeConnectionError ||
        error instanceof Stripe.errors.StripeAPIError
      ) {
        // Stripe is down or we're being throttled — circuit breaker tracks this
        throw new ProviderUnavailableException('stripe', error);
      }

      if (error instanceof Stripe.errors.StripeAuthenticationError) {
        // Wrong API key — ops problem, not a retry candidate
        throw new PaymentConfigurationException(
          'Stripe authentication failed — check STRIPE_SECRET_KEY',
        );
      }

      if (error instanceof Stripe.errors.StripeInvalidRequestError) {
        // Malformed API call — our bug, not customer's
        throw new PaymentConfigurationException(error.message);
      }

      // Unknown error — treat as unavailable, let circuit breaker decide
      this.logger.error(`Unknown Stripe error: ${error.message}`, error.stack);
      throw new ProviderUnavailableException('stripe', error);
    }
  }

  // ─── refund() ─────────────────────────────────────────────────────────

  async refund(params: {
    transactionId: string;
    amount?: number;
    reason?: string;
  }): Promise<RefundResult> {
    try {
      const refund = await this.client.refunds.create({
        payment_intent: params.transactionId,
        ...(params.amount && { amount: Math.round(params.amount * 100) }),
        ...(params.reason && {
          reason: params.reason as Stripe.RefundCreateParams.Reason,
        }),
      });

      return {
        success: true,
        refundId: refund.id,
        amount: refund.amount / 100,
        processedAt: new Date(refund.created * 1000),
      };
    } catch (error) {
      this.logger.error(`Refund failed: ${error.message}`);
      throw new ProviderUnavailableException('stripe', error);
    }
  }

  // ─── healthCheck() ────────────────────────────────────────────────────

  async healthCheck(): Promise<boolean> {
    try {
      await this.client.balance.retrieve();
      return true;
    } catch {
      return false;
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  /**
   * Maps Stripe's machine-readable decline codes to human-readable messages.
   * These go into customer notification emails — keep them friendly.
   */
  private humanizeDeclineCode(code: string): string {
    const messages: Record<string, string> = {
      card_declined: 'Your card was declined',
      insufficient_funds: 'Insufficient funds on your card',
      expired_card: 'Your card has expired',
      incorrect_cvc: 'Incorrect card security code',
      processing_error: 'A processing error occurred — please try again',
      do_not_honor: 'Your card was declined by your bank',
      lost_card: 'Your card has been reported lost',
      stolen_card: 'Your card has been reported stolen',
    };

    return messages[code] ?? 'Your payment could not be processed';
  }
}