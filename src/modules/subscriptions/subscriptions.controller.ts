import {
  Controller,
  Post,
  Delete,
  Get,
  Param,
  Body,
  UseGuards,
  UseInterceptors,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import { CreateSubscriptionDto } from '../subscriptions/dto/subscriptions.dto';
import { IdempotencyInterceptor } from '../../common/interceptors/Idempotency.interceptor';
import {
  RequiresIdempotencyGuard,
  RequiresIdempotencyKey,
} from '../../common/guards/Idempotency.guard';
import { SubscriptionService } from './subscriptions.service';

/**
 * WHY @UseInterceptors at the controller level, not globally?
 *
 * Global interceptors run on every endpoint in the app — including
 * GET /health, GET /metrics, and any read-only route. Those don't
 * need idempotency processing. Scoping to this controller means only
 * subscription-related endpoints go through the idempotency check.
 *
 * The interceptor is a no-op when no Idempotency-Key header is present
 * anyway, but it still runs the header check on every request. Keeping
 * it scoped is cleaner and marginally faster.
 */
@Controller('subscriptions')
@UseInterceptors(IdempotencyInterceptor)
export class SubscriptionsController {
  constructor(private readonly subscriptionService: SubscriptionService) {}

  // ── POST /api/subscriptions ─────────────────────────────────────────────

  /**
   * Creates a subscription and queues the first charge.
   *
   * WHY @HttpCode(201) explicitly?
   * NestJS defaults all POST responses to 200. 201 Created is the
   * correct semantic when a new resource is created. The idempotency
   * interceptor reads response.statusCode to cache it — so the
   * replayed response will also correctly return 201.
   *
   * Required headers:
   *   Idempotency-Key: <uuid>  ← enforced by RequiresIdempotencyGuard
   *
   * Execution order:
   *   RequiresIdempotencyGuard → IdempotencyInterceptor → subscribe() → cache
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(RequiresIdempotencyGuard)
  @RequiresIdempotencyKey()
  async subscribe(@Body() dto: CreateSubscriptionDto) {
    /**
     * WHY no try/catch here?
     * GlobalExceptionFilter handles ALL exceptions.
     * CustomerNotFoundException → 404
     * DuplicateSubscriptionException → 409
     * InactivePlanException → 403
     * The controller stays clean — it's just wiring, not error logic.
     */
    return this.subscriptionService.subscribe(dto);
  }

  // ── GET /api/subscriptions/active?customerId= ───────────────────────────

  /**
   * WHY a query param instead of /api/subscriptions/active/:customerId?
   * Route param would conflict with /:id — NestJS can't distinguish
   * 'active' from a UUID in the same position. Query param avoids ambiguity.
   *
   * WHY before /:id in the file?
   * NestJS matches routes top-to-bottom. If /:id is declared first,
   * GET /subscriptions/active would match /:id with id='active',
   * then ParseUUIDPipe would throw because 'active' isn't a UUID.
   * Specific routes ALWAYS go before parameterized routes.
   */
  @Get('active')
  async getActive(@Query('customerId', ParseUUIDPipe) customerId: string) {
    return this.subscriptionService.getActiveSubscription(customerId);
  }

  // ── GET /api/subscriptions/:id ──────────────────────────────────────────

  /**
   * WHY ParseUUIDPipe on all UUID params?
   * Without it, a client calling GET /subscriptions/not-a-uuid
   * reaches the service, which does a DB query for an invalid ID,
   * gets null, throws SubscriptionNotFoundException.
   *
   * With ParseUUIDPipe: NestJS validates the format BEFORE the handler
   * runs and returns a 400 with "Validation failed (uuid is expected)".
   * Cheaper (no DB round-trip) and more precise error message.
   */
  @Get(':id')
  async findById(@Param('id', ParseUUIDPipe) id: string) {
    return this.subscriptionService.findById(id);
  }

  // ── DELETE /api/subscriptions/:id ──────────────────────────────────────
  // Soft cancel — sets cancel_at_period_end = true

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RequiresIdempotencyGuard)
  @RequiresIdempotencyKey()
  async cancel(@Param('id', ParseUUIDPipe) id: string) {
    return this.subscriptionService.cancel(id);
  }

  // ── DELETE /api/subscriptions/:id/now ──────────────────────────────────
  // Hard cancel — terminates access immediately

  /**
   * WHY a separate /now route instead of a query param like ?immediate=true?
   *
   * These are two fundamentally different operations with different
   * consequences for the customer. Separate routes make the intent
   * unmistakable in logs, access control policies, and API docs.
   * A query param buries the distinction — easy to miss, easy to typo.
   *
   * /subscriptions/:id        DELETE → "cancel when period ends"
   * /subscriptions/:id/now    DELETE → "cut access right now"
   *
   * The route itself IS the documentation.
   */
  @Delete(':id/now')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RequiresIdempotencyGuard)
  @RequiresIdempotencyKey()
  async cancelImmediately(@Param('id', ParseUUIDPipe) id: string) {
    return this.subscriptionService.cancelImmediately(id);
  }
}