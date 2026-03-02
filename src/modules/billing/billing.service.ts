import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';

import {
  BILLING_JOBS,
  BILLING_RETRY_CONFIG,
  PaymentStatus,
} from '../subscriptions/subscription.enum';
import { InvoiceNotFoundException } from '../../common/exceptions/domain.exception';
import { Payment } from '../payments/entity/payment.entity';
import { Customer } from '../customers/entity/customer.entity';
import { Invoice } from '../invoice/entity/invoice.entity';
import { CircuitBreaker, CircuitBreakerOpenException } from './circuitBreaker';
import { InvoiceService } from '../invoice/invoice.service';
import { NotificationService } from '../notifications/notifications.service';
import { InvoiceStatus } from '../invoice/invoice.enum';

// ─── DTOs ──────────────────────────────────────────────────────────────────

export interface ChargeResult {
  success: boolean;
  externalTransactionId?: string;
  failureReason?: string;
}

// ─── Stripe Stub ───────────────────────────────────────────────────────────

/**
 * WHY a stub instead of real Stripe SDK right now?
 *
 * Same principle as NotificationService — get the FLOW right first.
 * Stripe SDK adds: API keys, webhook validation, idempotency keys,
 * error type handling (CardError vs RateLimitError vs NetworkError).
 * That's a separate concern. The billing ORCHESTRATION logic is what
 * we're building here.
 *
 * In production: inject a PaymentProvider interface. Stripe, PayPal,
 * and Paddle become swappable implementations. The BillingService
 * never changes when you add a new provider.
 */
interface StripeChargeParams {
  amount: number;
  currency: string;
  customerId: string;
  invoiceId: string;
}

async function stubStripeCharge(params: StripeChargeParams): Promise<ChargeResult> {
  // Simulate 80% success rate for development
  const success = Math.random() > 0.2;

  if (success) {
    return {
      success: true,
      externalTransactionId: `ch_stub_${Date.now()}_${params.invoiceId.slice(0, 8)}`,
    };
  }

  return {
    success: false,
    failureReason: 'Card declined',
  };
}

// ─── Service ───────────────────────────────────────────────────────────────

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  /**
   * WHY instantiate CircuitBreaker here and not inject it?
   *
   * The circuit breaker's state (failure count, open/closed) must be
   * per-provider and survive across multiple BillingService calls within
   * the same process. If injected as a NestJS provider with default scope,
   * it could be re-instantiated unexpectedly.
   *
   * For a single-provider setup, owning the instance here is simple
   * and predictable. For multi-provider: inject a CircuitBreakerRegistry
   * that holds one breaker per provider key.
   */
  private readonly stripeCircuitBreaker = new CircuitBreaker({
    failureThreshold: 5,
    cooldownMs: 60_000,
    provider: 'stripe',
  });

  constructor(
    @InjectRepository(Payment)
    private readonly paymentRepo: Repository<Payment>,

    @InjectRepository(Invoice)
    private readonly invoiceRepo: Repository<Invoice>,

    @InjectRepository(Customer)
    private readonly customerRepo: Repository<Customer>,

    @InjectQueue(BILLING_JOBS.CHARGE_INVOICE)
    private readonly billingQueue: Queue,

    private readonly invoiceService: InvoiceService,
    private readonly notificationService: NotificationService,

    /**
     * WHY inject DataSource instead of using a transaction decorator?
     * NestJS transaction decorators exist but they're magic.
     * Explicit DataSource.transaction() calls make the atomic boundary
     * visible and obvious. When a junior reads this code, they KNOW
     * exactly which writes are inside the transaction.
     */
    private readonly dataSource: DataSource,
  ) { }

  // ─── Queue Dispatch (called by SubscriptionService) ───────────────────────

  /**
   * Adds a charge job to the BullMQ queue.
   *
   * WHY is this a separate method instead of calling billingQueue.add() directly
   * from SubscriptionService?
   *
   * Queue job configuration (attempts, backoff, delay) is billing logic.
   * It belongs in BillingService, not in SubscriptionService.
   * SubscriptionService just says "this invoice needs charging."
   * HOW it gets charged is BillingService's concern.
   */
  async queueCharge(invoiceId: string): Promise<void> {
    await this.billingQueue.add(
      BILLING_JOBS.CHARGE_INVOICE,
      { invoiceId, attemptNumber: 1 },
      {
        /**
         * WHY jobId = invoiceId?
         * BullMQ deduplicates jobs with the same ID. If SubscriptionService
         * somehow calls queueCharge twice for the same invoice (network retry,
         * bug), only one job enters the queue. Free idempotency.
         */
        jobId: `charge-${invoiceId}`,
        attempts: 1, // BullMQ-level retries disabled — we manage retries ourselves
        removeOnComplete: true,
        removeOnFail: false, // keep failed jobs visible for debugging
      },
    );

    this.logger.log(`Charge job queued for invoice ${invoiceId}`);
  }

  // ─── Attempt Charge (called by BillingProcessor worker) ──────────────────

  /**
   * The core billing execution method. Called by the BullMQ processor.
   *
   * WHY does this method receive attemptNumber?
   * Because the retry decision and the error message both depend on
   * how many times we've already tried. The processor passes this from
   * the job payload so we have full context.
   *
   * Flow:
   *   1. Validate: invoice exists and is still OPEN
   *   2. Load customer for payment method
   *   3. Call Stripe (through circuit breaker)
   *   4. Success → handleSuccess (atomic DB write)
   *   5. Failure → handleFailure (queue retry or give up)
   */
  async attemptCharge(invoiceId: string, attemptNumber: number = 1): Promise<void> {
    this.logger.log(
      `Attempting charge for invoice ${invoiceId} (attempt ${attemptNumber}/${BILLING_RETRY_CONFIG.MAX_ATTEMPTS})`,
    );

    // ── GUARD: invoice must exist ──────────────────────────────────────────
    const invoice = await this.invoiceRepo.findOne({
      where: { id: invoiceId },
      relations: ['subscription'],
    });

    if (!invoice) {
      throw new InvoiceNotFoundException(invoiceId);
    }

    // ── GUARD: don't charge already-paid or void invoices ─────────────────
    /**
     * WHY this guard?
     * Race condition scenario:
     * - Job 1 picks up the charge, starts processing
     * - Job 2 (duplicate somehow) also picks up, also starts
     * - Job 1 succeeds, marks invoice PAID
     * - Job 2 checks here, sees PAID, exits cleanly
     *
     * Without this check, Job 2 would charge the customer twice.
     * This is your last line of defense beyond the unique index on
     * external_transaction_id.
     */
    if (invoice.status !== InvoiceStatus.OPEN) {
      this.logger.warn(
        `Invoice ${invoiceId} is already ${invoice.status} — skipping charge`,
      );
      return;
    }

    // ── Load customer ──────────────────────────────────────────────────────
    const customer = await this.customerRepo.findOne({
      where: { id: invoice.customer_id },
    });

    if (!customer) {
      this.logger.error(`Customer ${invoice.customer_id} not found for invoice ${invoiceId}`);
      await this.handleFailure(invoice, 'Customer not found', attemptNumber, customer);
      return;
    }

    // ── Call payment provider through circuit breaker ─────────────────────
    try {
      const result = await this.stripeCircuitBreaker.call(() =>
        stubStripeCharge({
          amount: invoice.amount,
          currency: invoice.currency,
          customerId: customer.id,
          invoiceId: invoice.id,
        }),
      );

      if (result.success && result.externalTransactionId) {
        await this.handleSuccess(invoice, result.externalTransactionId, customer);
      } else {
        await this.handleFailure(invoice, result.failureReason, attemptNumber, customer);
      }
    } catch (error) {
      if (error instanceof CircuitBreakerOpenException) {
        /**
         * WHY treat circuit breaker open differently from payment failure?
         *
         * A payment failure = the customer's card was declined.
         *   → Notify customer, retry with normal backoff.
         *
         * Circuit open = Stripe is down, NOT the customer's fault.
         *   → Don't notify customer (their card is fine).
         *   → Re-queue with longer delay to wait for Stripe recovery.
         *   → Send internal alert to ops team.
         */
        this.logger.error(
          `Circuit breaker OPEN for invoice ${invoiceId} — re-queuing with extended delay`,
        );
        await this.notificationService.sendInternalAlert(
          'Stripe Circuit Breaker Open',
          { invoiceId, attemptNumber },
        );
        // Re-queue with 5 minute delay — wait for Stripe recovery
        await this.scheduleRetry(invoiceId, attemptNumber, 5 * 60 * 1000);
        return;
      }

      // Unknown error — log and re-throw for BullMQ to handle
      this.logger.error(`Unexpected error charging invoice ${invoiceId}: ${error.message}`);
      throw error;
    }
  }

  // ─── Handle Success ───────────────────────────────────────────────────────

  /**
   * Atomically records the payment and transitions the invoice to PAID.
   *
   * WHY one transaction for both writes?
   * Consider what happens if they're separate:
   *
   *   WRONG:
   *     await paymentRepo.save(payment);  // payment recorded
   *     // 💥 server crashes here
   *     await invoiceService.markAsPaid(invoice.id);  // never runs
   *
   * Result: Payment record exists (customer was charged) but invoice
   * shows OPEN (billing system thinks they haven't paid). Your support
   * team gets a ticket, manually reconciles, loses trust.
   *
   * With a transaction: both succeed or both roll back. No partial state.
   */
  private async handleSuccess(
    invoice: Invoice,
    externalTransactionId: string,
    customer: Customer,
  ): Promise<void> {
    this.logger.log(
      `Payment succeeded for invoice ${invoice.id} — tx: ${externalTransactionId}`,
    );

    await this.dataSource.transaction(async (manager) => {
      // Write 1: Create the payment record
      const payment = manager.create(Payment, {
        invoice_id: invoice.id,
        amount: invoice.amount,
        provider: customer.payment_provider,
        external_transaction_id: externalTransactionId,
        status: PaymentStatus.SUCCEEDED,
      });
      await manager.save(Payment, payment);

      // Write 2: Transition invoice to PAID
      // WHY use manager.update instead of invoiceService.markAsPaid?
      // invoiceService.markAsPaid does its own save() outside our transaction.
      // Inside a transaction, all writes MUST use the transaction's manager.
      // Calling external service methods inside transactions is a common
      // junior mistake that silently breaks atomicity.
      invoice.status = InvoiceStatus.PAID;
      invoice.metadata = {
        ...(invoice.metadata ?? {}),
        paid_via_transaction: externalTransactionId,
        paid_at: new Date().toISOString(),
      };
      await manager.save(invoice);

    });

    /**
     * WHY send notification AFTER the transaction commits?
     * If notification fires inside the transaction and the transaction
     * rolls back, the customer gets a "payment success" email for a
     * payment that didn't actually persist. Always notify after commit.
     */
    await this.notificationService.sendPaymentSuccess({
      customerEmail: customer.email,
      customerName: customer.full_name,
      invoiceId: invoice.id,
      amount: invoice.amount,
      currency: invoice.currency,
      paidAt: new Date(),
    });

    this.logger.log(`Invoice ${invoice.id} successfully paid and notification sent`);
  }

  // ─── Handle Failure ───────────────────────────────────────────────────────

  /**
   * Decides: retry or give up?
   *
   * WHY take the full Customer object and not just email?
   * At this point customer might be null (customer-not-found failure case).
   * Accepting Customer | null | undefined forces explicit null handling
   * rather than hoping the caller always passes a valid customer.
   */
  private async handleFailure(
    invoice: Invoice,
    failureReason: string | undefined,
    attemptNumber: number,
    customer: Customer | null | undefined,
  ): Promise<void> {
    const reason = failureReason ?? 'Unknown error';
    const isFinalAttempt = attemptNumber >= BILLING_RETRY_CONFIG.MAX_ATTEMPTS;

    this.logger.warn(
      `Payment failed for invoice ${invoice.id} — attempt ${attemptNumber}/${BILLING_RETRY_CONFIG.MAX_ATTEMPTS} — reason: ${reason}`,
    );

    if (isFinalAttempt) {
      // All attempts exhausted — give up and mark as uncollectible
      await this.invoiceService.markAsUncollectible(invoice.id, reason);

      /**
       * WHY emit an event here rather than calling SubscriptionService directly?
       *
       * Circular dependency risk:
       *   BillingService → SubscriptionService → BillingService (circular!)
       *
       * Solution: BillingService emits to the queue. SubscriptionService
       * has a processor that listens and calls moveToPastDue().
       * Alternatively: use NestJS EventEmitter2 to decouple completely.
       *
       * For now we'll queue a job with the subscription_id to trigger
       * the past_due transition in SubscriptionService's processor.
       */
      await this.billingQueue.add(
        'subscription_payment_exhausted',
        { subscriptionId: invoice.subscription_id, invoiceId: invoice.id },
      );

      if (customer) {
        await this.notificationService.sendPaymentFailed({
          customerEmail: customer.email,
          customerName: customer.full_name,
          invoiceId: invoice.id,
          amount: invoice.amount,
          currency: invoice.currency,
          attemptNumber,
          maxAttempts: BILLING_RETRY_CONFIG.MAX_ATTEMPTS,
          failureReason: reason,
        });
      }

      return;
    }

    // ── Not final — schedule a retry ──────────────────────────────────────
    const delayMs = BILLING_RETRY_CONFIG.DELAYS_MS[attemptNumber - 1];
    const nextRetryAt = new Date(Date.now() + delayMs);

    await this.scheduleRetry(invoice.id, attemptNumber + 1, delayMs);

    if (customer) {
      await this.notificationService.sendPaymentFailed({
        customerEmail: customer.email,
        customerName: customer.full_name,
        invoiceId: invoice.id,
        amount: invoice.amount,
        currency: invoice.currency,
        attemptNumber,
        maxAttempts: BILLING_RETRY_CONFIG.MAX_ATTEMPTS,
        nextRetryAt,
        failureReason: reason,
      });
    }
  }

  // ─── Schedule Retry ───────────────────────────────────────────────────────

  /**
   * WHY a private scheduleRetry instead of inlining billingQueue.add()?
   *
   * Retry scheduling appears in two places:
   * 1. handleFailure (normal payment failure)
   * 2. attemptCharge (circuit breaker open)
   *
   * Both need the same job configuration. One method, zero duplication.
   * If you change the job options (add priority, change removal policy),
   * you change it once.
   */
  private async scheduleRetry(
    invoiceId: string,
    nextAttemptNumber: number,
    delayMs: number,
  ): Promise<void> {
    await this.billingQueue.add(
      BILLING_JOBS.RETRY_CHARGE,
      { invoiceId, attemptNumber: nextAttemptNumber },
      {
        delay: delayMs,
        jobId: `retry-${invoiceId}-attempt-${nextAttemptNumber}`,
        removeOnComplete: true,
        removeOnFail: false,
      },
    );

    this.logger.log(
      `Retry scheduled for invoice ${invoiceId} — attempt ${nextAttemptNumber} in ${delayMs / 1000}s`,
    );
  }

}