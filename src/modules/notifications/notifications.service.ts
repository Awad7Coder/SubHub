import { Injectable, Logger } from '@nestjs/common';

/**
 * WHY does NotificationService accept flat data instead of entity objects?
 *
 * A common mistake is passing the full Invoice or Customer entity into
 * notification methods:
 *   sendPaymentSuccess(customer: Customer, invoice: Invoice)
 *
 * This creates tight coupling: NotificationService now implicitly depends
 * on TypeORM entities, which means it can't be used without a DB context
 * and is harder to unit test.
 *
 * Instead, accept exactly the data needed for the notification:
 *   sendPaymentSuccess({ customerEmail, amount, invoiceId })
 *
 * This makes NotificationService a pure function of its inputs.
 * Swap the email provider tomorrow? Only this file changes.
 */

// ─── Payload Types ─────────────────────────────────────────────────────────

export interface PaymentSuccessPayload {
  customerEmail: string;
  customerName?: string;
  invoiceId: string;
  amount: number;
  currency: string;
  paidAt: Date;
}

export interface PaymentFailedPayload {
  customerEmail: string;
  customerName?: string;
  invoiceId: string;
  amount: number;
  currency: string;
  attemptNumber: number;
  maxAttempts: number;
  nextRetryAt?: Date;      // undefined if this was the final attempt
  failureReason?: string;
}

export interface UsageWarningPayload {
  customerEmail: string;
  customerName?: string;
  subscriptionId: string;
  actionType: string;
  percentUsed: number;
  currentUsage: number;
  usageLimit: number;
  periodEnd: Date;
}

export interface SubscriptionCancelledPayload {
  customerEmail: string;
  customerName?: string;
  planName: string;
  cancelledAt: Date;
  accessUntil: Date;       // when they actually lose access (period end)
  cancelledImmediately: boolean;
}

export interface SubscriptionRenewedPayload {
  customerEmail: string;
  customerName?: string;
  planName: string;
  amount: number;
  currency: string;
  nextPeriodEnd: Date;
}

// ─── Service ───────────────────────────────────────────────────────────────

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  /**
   * WHY log as the implementation instead of real email calls?
   *
   * Phase 3 is about getting the business logic right first.
   * Wiring a real email provider (SendGrid, Resend, SES) involves
   * API keys, template IDs, and error handling that would distract
   * from the core billing flow.
   *
   * Build with console.log stubs → verify the right events fire
   * at the right times → swap in real provider → done.
   *
   * This is called "Stub-first development" and it's how senior
   * engineers keep momentum without getting blocked on integrations.
   *
   * In production, inject an EmailProvider interface here and swap
   * implementations via NestJS dependency injection.
   */

  // ─── Payment Events ──────────────────────────────────────────────────────

  async sendPaymentSuccess(payload: PaymentSuccessPayload): Promise<void> {
    this.logger.log(
      `[EMAIL] Payment success → ${payload.customerEmail} | Invoice: ${payload.invoiceId} | Amount: ${payload.amount} ${payload.currency}`,
    );

    /**
     * PRODUCTION REPLACEMENT:
     *
     * await this.emailProvider.send({
     *   to: payload.customerEmail,
     *   template: 'payment-success',
     *   data: {
     *     name: payload.customerName,
     *     amount: formatCurrency(payload.amount, payload.currency),
     *     invoiceUrl: `https://app.subhub.io/invoices/${payload.invoiceId}`,
     *     date: payload.paidAt.toLocaleDateString(),
     *   }
     * });
     */
  }

  async sendPaymentFailed(payload: PaymentFailedPayload): Promise<void> {
    const isFinalAttempt = payload.attemptNumber >= payload.maxAttempts;

    /**
     * WHY different log levels based on whether this is the final attempt?
     *
     * First failure: warn (might auto-recover)
     * Final failure: error (needs human attention, subscription going past_due)
     *
     * Your alerting system (PagerDuty, OpsGenie) should trigger on `error`
     * level logs but not `warn`. This distinction matters at 3am.
     */
    if (isFinalAttempt) {
      this.logger.error(
        `[EMAIL] FINAL payment failure → ${payload.customerEmail} | Invoice: ${payload.invoiceId} | All ${payload.maxAttempts} attempts exhausted`,
      );
    } else {
      this.logger.warn(
        `[EMAIL] Payment failed (attempt ${payload.attemptNumber}/${payload.maxAttempts}) → ${payload.customerEmail} | Next retry: ${payload.nextRetryAt?.toISOString()}`,
      );
    }

    /**
     * PRODUCTION NOTE:
     * Send different email templates based on isFinalAttempt:
     * - Not final: "We couldn't charge your card — we'll try again on {date}"
     * - Final: "Your subscription is suspended — please update your payment method"
     *
     * Include a direct link to the payment update page. Every extra click
     * costs you a customer recovery.
     */
  }

  // ─── Usage Events ────────────────────────────────────────────────────────

  async sendUsageLimitWarning(payload: UsageWarningPayload): Promise<void> {
    this.logger.warn(
      `[EMAIL] Usage warning → ${payload.customerEmail} | ${payload.actionType}: ${payload.currentUsage}/${payload.usageLimit} (${payload.percentUsed}%) | Period ends: ${payload.periodEnd.toISOString()}`,
    );

    /**
     * PRODUCTION NOTE:
     * This is a conversion opportunity, not just a warning.
     * Include an upgrade CTA in this email.
     * "You've used 80% of your API calls. Upgrade to Pro for 10x more."
     * Customers who upgrade from warning emails have high LTV.
     */
  }

  // ─── Subscription Events ─────────────────────────────────────────────────

  async sendSubscriptionCancelled(payload: SubscriptionCancelledPayload): Promise<void> {
    this.logger.log(
      `[EMAIL] Subscription cancelled → ${payload.customerEmail} | Plan: ${payload.planName} | Access until: ${payload.accessUntil.toISOString()} | Immediate: ${payload.cancelledImmediately}`,
    );

    /**
     * PRODUCTION NOTE:
     * Include a win-back link. "Changed your mind? Reactivate before
     * {accessUntil date} and keep all your data."
     *
     * Also: trigger a win-back sequence in your CRM (HubSpot, Salesforce)
     * to follow up at 7 days, 30 days, 90 days post-cancellation.
     */
  }

  async sendSubscriptionRenewed(payload: SubscriptionRenewedPayload): Promise<void> {
    this.logger.log(
      `[EMAIL] Subscription renewed → ${payload.customerEmail} | Plan: ${payload.planName} | Amount: ${payload.amount} ${payload.currency} | Next renewal: ${payload.nextPeriodEnd.toISOString()}`,
    );
  }

  // ─── Admin/Internal Alerts ───────────────────────────────────────────────

  /**
   * WHY an internal alert method?
   *
   * Some events need engineering/ops attention, not customer emails.
   * Circuit breaker opening, payment provider downtime, DB connection failures.
   * These go to Slack/PagerDuty, not customer inboxes.
   *
   * Same service, different channel. Don't build a separate AlertService
   * until the complexity genuinely demands it.
   */
  async sendInternalAlert(subject: string, details: Record<string, any>): Promise<void> {
    this.logger.error(
      `[INTERNAL ALERT] ${subject} | ${JSON.stringify(details)}`,
    );

    /**
     * PRODUCTION REPLACEMENT:
     * await this.slackProvider.sendToChannel('#billing-alerts', {
     *   text: subject,
     *   blocks: buildSlackBlocks(details),
     * });
     */
  }

  async sendRefundConfirmation(
    customerId: string,
    invoiceId: string,
    amountRefunded: number,
  ): Promise<void> {
    this.logger.log(
      `Sending refund confirmation — customer: ${customerId}, ` +
      `invoice: ${invoiceId}, amount: $${amountRefunded.toFixed(2)}`,
    );}
}