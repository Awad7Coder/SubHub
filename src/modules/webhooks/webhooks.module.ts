import { Module } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { InvoiceModule } from '../invoice/invoice.module';
import { SubscriptionModule } from '../subscriptions/subscriptions.module';
import { BillingModule } from '../billing/billing.module';
import { NotificationModule } from '../notifications/notifications.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProcessedWebhookEvent } from './entity/webhookevent.entity';

/**
 * WHY import these modules instead of injecting services directly?
 *
 * Each service lives in its own module which controls what it exports.
 * To use InvoiceService here, InvoiceModule must export it AND we must
 * import InvoiceModule. This is NestJS's dependency boundary system —
 * it prevents accidental coupling between unrelated modules.
 *
 * If a service isn't exported by its module, NestJS throws at startup:
 * "Nest can't resolve dependencies of WebhooksService"
 *
 * Check that each of these modules exports the service we need:
 *   InvoiceModule    → exports InvoiceService
 *   SubscriptionModule → exports SubscriptionService
 *   BillingModule    → exports BillingService
 *   NotificationsModule → exports NotificationsService
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([ProcessedWebhookEvent]),
    InvoiceModule,
    SubscriptionModule,
    BillingModule,
    NotificationModule,
  ],
  controllers: [WebhooksController],
  providers: [WebhooksService],
})
export class WebhooksModule {}