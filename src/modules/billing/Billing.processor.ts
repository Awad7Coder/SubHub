import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { BillingService } from './billing.service';
import { BILLING_JOBS } from '../subscriptions/subscription.enum';
import { SubscriptionService } from '../subscriptions/subscriptions.service';

/**
 * WHY separate Processor from Service?
 *
 * BillingService contains the LOGIC: "how do I charge an invoice?"
 * BillingProcessor contains the TRANSPORT: "how do I receive a queued job?"
 *
 * This separation means:
 * 1. BillingService is testable without BullMQ running
 * 2. If you swap BullMQ for SQS tomorrow, only the Processor changes
 * 3. The Processor is thin — it just unpacks the job and delegates
 *
 * A Processor with business logic in it is a common anti-pattern.
 * Keep it thin.
 */

interface ChargeJobPayload {
  invoiceId: string;
  attemptNumber: number;
}

interface SubscriptionExhaustedPayload {
  subscriptionId: string;
  invoiceId: string;
}

@Processor(BILLING_JOBS.CHARGE_INVOICE)
export class BillingProcessor extends WorkerHost {
  private readonly logger = new Logger(BillingProcessor.name);

  constructor(
    private readonly billingService: BillingService,
    private readonly subscriptionService: SubscriptionService,
  ) {
    super();
  }

  /**
   * WHY a switch on job.name instead of separate processors per job type?
   *
   * One queue, multiple job types is a common pattern.
   * All billing-related jobs share the same queue so they're processed
   * in order and share the same concurrency settings.
   *
   * Alternative: separate queues per job type. Use that when job types
   * have very different priorities or concurrency needs.
   * For now, one queue keeps the system simpler.
   */
  async process(job: Job): Promise<void> {
    this.logger.log(`Processing job: ${job.name} (id: ${job.id})`);

    switch (job.name) {
      case BILLING_JOBS.CHARGE_INVOICE:
        return this.handleChargeInvoice(job as Job<ChargeJobPayload>);

      case BILLING_JOBS.RETRY_CHARGE:
        return this.handleRetryCharge(job as Job<ChargeJobPayload>);

      case 'subscription_payment_exhausted':
        return this.handlePaymentExhausted(job as Job<SubscriptionExhaustedPayload>);

      default:
        this.logger.warn(`Unknown job type received: ${job.name}`);
    }
  }

  // ─── Job Handlers ─────────────────────────────────────────────────────────

  private async handleChargeInvoice(job: Job<ChargeJobPayload>): Promise<void> {
    const { invoiceId, attemptNumber } = job.data;

    try {
      await this.billingService.attemptCharge(invoiceId, attemptNumber);
    } catch (error) {
      this.logger.error(
        `Charge job failed for invoice ${invoiceId}: ${error.message}`,
      );
      /**
       * WHY re-throw here?
       * BullMQ marks jobs as FAILED when the processor throws.
       * Failed jobs are visible in the BullMQ dashboard (Bull Board).
       * Swallowing the error here would mark the job as SUCCESS
       * even though the charge didn't go through — silent data loss.
       */
      throw error;
    }
  }

  private async handleRetryCharge(job: Job<ChargeJobPayload>): Promise<void> {
    const { invoiceId, attemptNumber } = job.data;

    this.logger.log(
      `Processing retry: invoice ${invoiceId}, attempt ${attemptNumber}`,
    );

    // Retry uses the same logic as the initial charge — just a different attempt number
    await this.handleChargeInvoice(job);
  }

  private async handlePaymentExhausted(
    job: Job<SubscriptionExhaustedPayload>,
  ): Promise<void> {
    const { subscriptionId } = job.data;

    this.logger.warn(
      `All payment attempts exhausted for subscription ${subscriptionId} — moving to past_due`,
    );

    await this.subscriptionService.moveToPastDue(subscriptionId);
  }
}