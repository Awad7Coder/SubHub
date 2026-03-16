import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
  UseInterceptors,
  ParseUUIDPipe,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetPaymentHistoryQueryDto } from '../payments/dto/payment.dto';
import { IdempotencyInterceptor } from '../../common/interceptors/Idempotency.interceptor';
import {
  RequiresIdempotencyGuard,
  RequiresIdempotencyKey,
} from '../../common/guards/Idempotency.guard';
import { InvoiceNotFoundException } from '../../common/exceptions/domain.exception';
import { Payment } from './entity/payment.entity';
import { BillingService } from '../billing/billing.service';
import { InvoiceService } from '../invoice/invoice.service';
import { InvoiceStatus } from '../invoice/invoice.enum';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiQuery, ApiHeader } from '@nestjs/swagger';
import { PaymentThrottle } from '../../common/decorators/throttle.decorator';



@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  constructor(
    @InjectRepository(Payment)
    private readonly paymentRepo: Repository<Payment>,

    private readonly billingService: BillingService,
    private readonly invoiceService: InvoiceService,
  ) { }

  // ── GET /api/payments/invoice/:invoiceId ────────────────────────────────

  /**
   * Returns all payment attempts for a specific invoice.
   * Includes failed attempts — useful for support staff to see
   * "this card was declined 3 times before succeeding."
   */
  @Get('invoice/:invoiceId')
  @ApiOperation({ summary: 'Get payment attempts for an invoice', description: 'Returns all attempts including failures — useful for debugging declined payments.' })
  @ApiParam({ name: 'invoiceId', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Payment attempt list' })
  async getByInvoice(
    @Param('invoiceId', ParseUUIDPipe) invoiceId: string,
  ) {
    return this.paymentRepo.find({
      where: { invoice_id: invoiceId },
      order: { created_at: 'DESC' },
    });
  }

  // ── GET /api/payments/customer/:customerId ──────────────────────────────

  /**
   * Returns paginated payment history for a customer.
   *
   * WHY pagination here but not on other GET endpoints?
   * A customer's payment history grows indefinitely — one row per
   * billing cycle, potentially years of history. Returning all rows
   * is unbounded. Invoices per subscription and open invoices are
   * naturally bounded (small counts), so pagination there is premature.
   *
   * Default: 20 per page, page 1. Configurable via query params.
   */
  @Get('customer/:customerId')
  @ApiOperation({ summary: 'Get payment history for a customer' })
  @ApiParam({ name: 'customerId', type: String, format: 'uuid' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiResponse({ status: 200, description: 'Paginated payment history' })
  async getByCustomer(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Query() query: GetPaymentHistoryQueryDto,
  ) {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100); // cap at 100 — never unbounded
    const skip = (page - 1) * limit;

    const [payments, total] = await this.paymentRepo
      .createQueryBuilder('payment')
      .innerJoin('payment.invoice', 'invoice')
      .where('invoice.customer_id = :customerId', { customerId })
      .orderBy('payment.created_at', 'DESC')
      .skip(skip)
      .take(limit)
      .getManyAndCount();

    /**
     * WHY return a pagination envelope instead of just the array?
     * The client needs to know if there are more pages.
     * Without total and page metadata, they'd have to request page 2
     * and check if it's empty — wasteful and slow.
     *
     * Standard pagination response shape used by most REST APIs.
     */
    return {
      data: payments,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page < Math.ceil(total / limit),
      },
    };
  }

  // ── POST /api/payments/retry/:invoiceId ─────────────────────────────────

  /**
   * Manual payment retry — triggered when a customer updates their
   * payment method and wants to immediately retry a failed invoice.
   *
   * WHY does this endpoint exist alongside the BillingScheduler dunning?
   * The scheduler retries on a fixed schedule (every 6 hours).
   * A customer who just updated their card shouldn't wait up to 6 hours
   * for the next dunning cycle. This endpoint lets the UI say:
   * "Payment method updated! Retry now?" → instant gratification.
   *
   * WHY @UseInterceptors + @RequiresIdempotencyKey here?
   * This triggers a Stripe charge. If the client's retry button fires twice
   * (double-click, network retry), we must not charge twice.
   * Idempotency protection is mandatory on ALL charge-triggering endpoints.
   */
  @Post('retry/:invoiceId')
  @PaymentThrottle()
  @ApiOperation({
    summary: 'Retry a failed payment',
    description: `
        Manually triggers a charge retry for an OPEN invoice.

        Returns **202 Accepted** — the charge is queued, not yet processed.
        Poll \`GET /invoices/:id\` to check if status changed to \`paid\`.

        **Rate limited:** 5 requests per minute per IP.
    `,
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiParam({ name: 'invoiceId', type: String, format: 'uuid' })
  @ApiResponse({ status: 202, description: 'Retry queued' })
  @ApiResponse({ status: 422, description: 'Invoice is not in OPEN state — cannot retry' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded — 5 retries per minute' })
  @HttpCode(HttpStatus.ACCEPTED)
  @UseInterceptors(IdempotencyInterceptor)
  @UseGuards(RequiresIdempotencyGuard)
  @RequiresIdempotencyKey()
  async retryPayment(
    @Param('invoiceId', ParseUUIDPipe) invoiceId: string,
  ) {
    /**
     * WHY validate invoice state BEFORE queuing the job?
     * queueCharge() just puts a job in Redis — it doesn't validate anything.
     * Without this guard, a client could retry a PAID invoice, waste a
     * BullMQ job slot, and the worker would silently discard it (the
     * "status !== OPEN" check in attemptCharge).
     *
     * Better to fail fast with a 422 here than silently queue a no-op job.
     */
    const invoice = await this.invoiceService.findById(invoiceId);

    if (!invoice) {
      throw new InvoiceNotFoundException(invoiceId);
    }

    if (invoice.status !== InvoiceStatus.OPEN) {
      /**
       * WHY not use InvalidInvoiceStateException here?
       * InvalidInvoiceStateException is for internal state machine violations.
       * This is a client error — they asked to retry a non-retryable invoice.
       * The GlobalExceptionFilter maps it to 422 either way, but the message
       * is more helpful coming from a guard-level check with context.
       */
      const { UnprocessableEntityException } = await import('@nestjs/common');
      throw new UnprocessableEntityException({
        message: `Invoice ${invoiceId} cannot be retried — current status is '${invoice.status}'`,
        code: 'INVOICE_NOT_RETRYABLE',
        retryableStatuses: [InvoiceStatus.OPEN],
      });
    }

    await this.billingService.queueCharge(invoiceId);

    /**
     * WHY 202 Accepted and not 200 OK?
     * 200 OK means "the operation is done."
     * The payment isn't done — it's been QUEUED. The actual charge
     * happens asynchronously in the BullMQ worker.
     * 202 Accepted means "your request was accepted and will be processed."
     * This is the correct semantic for async job dispatch.
     */
    return {
      message: 'Payment retry queued successfully',
      invoiceId,
      status: 'queued',
    };
  }

}