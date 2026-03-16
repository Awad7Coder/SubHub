import { Injectable, Logger } from '@nestjs/common';
import Stripe from 'stripe';
import { InvoiceService } from '../invoice/invoice.service';
import { SubscriptionService } from '../subscriptions/subscriptions.service';
import { BillingService } from '../billing/billing.service';
import { NotificationService } from '../notifications/notifications.service';
import { InvoiceStatus } from '../invoice/invoice.enum';
import { SubscriptionStatus } from '../subscriptions/subscription.enum';
import { InjectRepository } from '@nestjs/typeorm';
import { ProcessedWebhookEvent } from './entity/webhookevent.entity';
import { QueryFailedError, Repository } from 'typeorm';

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    @InjectRepository(ProcessedWebhookEvent)
    private readonly processedEventRepo: Repository<ProcessedWebhookEvent>,


    private readonly invoiceService: InvoiceService,
    private readonly subscriptionService: SubscriptionService,
    private readonly billingService: BillingService,
    private readonly notificationService: NotificationService,
  ) { }

  async handleEvent(event: Stripe.Event): Promise<void> {
    this.logger.log(`Webhook received: ${event.type} [${event.id}]`);

    const isDuplicate = await this.markEventProcessed(event.id, event.type);
    if (isDuplicate) {
      this.logger.warn(`Duplicate webhook ignored: ${event.type} [${event.id}]`);
      return;
    }

    try {
      switch (event.type) {
        case 'payment_intent.succeeded':
          await this.onPaymentIntentSucceeded(event.data.object as Stripe.PaymentIntent);
          break;
        case 'payment_intent.payment_failed':
          await this.onPaymentIntentFailed(event.data.object as Stripe.PaymentIntent);
          break;
        case 'charge.refunded':
          await this.onChargeRefunded(event.data.object as Stripe.Charge);
          break;
        case 'customer.subscription.deleted':
          await this.onSubscriptionDeletedExternally(event.data.object as Stripe.Subscription);
          break;
        default:
          this.logger.debug(`Unhandled webhook event type: ${event.type}`);
      }
    } catch (error) {
      await this.unmarkEventProcessed(event.id); // allow Stripe retry
      throw error;
    }
  }

  // ── payment_intent.succeeded ─────────────────────────────────────────────

  private async onPaymentIntentSucceeded(
    paymentIntent: Stripe.PaymentIntent,
  ): Promise<void> {
    const invoiceId = paymentIntent.metadata?.invoiceId;
    if (!invoiceId) {
      this.logger.warn(`payment_intent.succeeded missing invoiceId — PI: ${paymentIntent.id}`);
      return;
    }

    try {
      const invoice = await this.invoiceService.findById(invoiceId);

      if (!invoice) {
        this.logger.warn(`payment_intent.succeeded: invoice ${invoiceId} not found`);
        return;
      }

      if (invoice.status === InvoiceStatus.PAID) {
        this.logger.debug(`Invoice ${invoiceId} already PAID — skipping reconciliation`);
        return;
      }

      this.logger.warn(
        `Reconciliation: marking invoice ${invoiceId} PAID via webhook (was ${invoice.status})`,
      );

      // markAsPaid is your existing method name
      await this.invoiceService.markAsPaid(invoiceId, paymentIntent.id);

      // Activate subscription if still PENDING
      if (invoice.subscription_id) {
        const sub = await this.subscriptionService.findById(invoice.subscription_id);
        if (sub && sub.status === SubscriptionStatus.PENDING) {
          await this.subscriptionService.activate(invoice.subscription_id);
        }
      }
    } catch (error) {
      this.logger.error(`Failed handling payment_intent.succeeded for ${invoiceId}: ${error.message}`);
      throw error;
    }
  }

  // ── payment_intent.payment_failed ───────────────────────────────────────

  private async onPaymentIntentFailed(
    paymentIntent: Stripe.PaymentIntent,
  ): Promise<void> {
    const invoiceId = paymentIntent.metadata?.invoiceId;
    const attemptNumber = parseInt(paymentIntent.metadata?.attemptNumber ?? '1', 10);

    if (!invoiceId) {
      this.logger.warn(`payment_intent.payment_failed missing invoiceId — PI: ${paymentIntent.id}`);
      return;
    }

    const declineCode =
      paymentIntent.last_payment_error?.decline_code ??
      paymentIntent.last_payment_error?.code ??
      'unknown';

    this.logger.warn(
      `Async payment failure: invoice ${invoiceId}, attempt ${attemptNumber}, decline: ${declineCode}`,
    );

    try {
      await this.billingService.handlePaymentFailure(
        invoiceId,
        attemptNumber,
        `async_decline:${declineCode}`,
      );
    } catch (error) {
      this.logger.error(`Failed handling payment_intent.payment_failed for ${invoiceId}: ${error.message}`);
      throw error;
    }
  }

  // ── charge.refunded ──────────────────────────────────────────────────────

  private async onChargeRefunded(charge: Stripe.Charge): Promise<void> {
    const invoiceId = charge.metadata?.invoiceId;
    if (!invoiceId) {
      this.logger.warn(`charge.refunded missing invoiceId — charge: ${charge.id}`);
      return;
    }

    try {
      const invoice = await this.invoiceService.findById(invoiceId);

      if (!invoice) {
        this.logger.warn(`charge.refunded: invoice ${invoiceId} not found`);
        return;
      }

      if (invoice.status === InvoiceStatus.REFUNDED) {
        this.logger.debug(`Invoice ${invoiceId} already REFUNDED — skipping`);
        return;
      }

      const isFullRefund = charge.amount_refunded === charge.amount;

      if (isFullRefund) {
        await this.invoiceService.markRefunded(invoiceId);
        this.logger.log(`Invoice ${invoiceId} marked REFUNDED via webhook`);

        if (invoice.customer_id) {
          await this.notificationService.sendRefundConfirmation(
            invoice.customer_id,
            invoiceId,
            charge.amount_refunded / 100,
          );
        }
      } else {
        this.logger.log(
          `Partial refund on invoice ${invoiceId}: ${charge.amount_refunded}/${charge.amount} cents`,
        );
      }
    } catch (error) {
      this.logger.error(`Failed handling charge.refunded for ${invoiceId}: ${error.message}`);
      throw error;
    }
  }

  // ── customer.subscription.deleted ───────────────────────────────────────

  private async onSubscriptionDeletedExternally(
    stripeSubscription: Stripe.Subscription,
  ): Promise<void> {
    const ourSubscriptionId = stripeSubscription.metadata?.subhubSubscriptionId;
    if (!ourSubscriptionId) {
      this.logger.warn(
        `customer.subscription.deleted missing subhubSubscriptionId — Stripe sub: ${stripeSubscription.id}`,
      );
      return;
    }

    try {
      const sub = await this.subscriptionService.findById(ourSubscriptionId);

      if (!sub || sub.status === SubscriptionStatus.CANCELLED) {
        this.logger.debug(`Subscription ${ourSubscriptionId} already CANCELLED — skipping`);
        return;
      }

      // cancelImmediately already exists on your SubscriptionService
      await this.subscriptionService.cancelImmediately(ourSubscriptionId);
      this.logger.log(`Subscription ${ourSubscriptionId} cancelled via Stripe webhook`);
    } catch (error) {
      this.logger.error(`Failed handling customer.subscription.deleted for ${ourSubscriptionId}: ${error.message}`);
      throw error;
    }
  }

  private async markEventProcessed(eventId: string, eventType: string): Promise<boolean> {
  try {
    await this.processedEventRepo.insert({ event_id: eventId, event_type: eventType });
    return false;
  } catch (error) {
    if (error instanceof QueryFailedError && (error as any).code === '23505') {
      return true; // duplicate
    }
    throw error;
  }
}

private async unmarkEventProcessed(eventId: string): Promise<void> {
  try {
    await this.processedEventRepo.delete({ event_id: eventId });
  } catch (error) {
    this.logger.error(`Failed to unmark event ${eventId}: ${error.message}`);
  }
}
}