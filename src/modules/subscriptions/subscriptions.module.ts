import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SubscriptionService } from './subscriptions.service';
import { BillingModule } from '../billing/billing.module';
import { UsageModule } from '../usage/usage.module';
import { Plan } from '../plan/entity/plan.entity';
import { Customer } from '../customers/entity/customer.entity';
import { InvoiceModule } from '../invoice/invoice.module';
import { NotificationModule } from '../notifications/notifications.module';
import { Subscription } from './entity/subscription.entity';
import { SubscriptionsController } from './subscriptions.controller';
import { IdempotencyModule } from '../idempotency/idempotency.module';

/**
 * WHY import so many modules here?
 *
 * SubscriptionService is the top of the Layer 2 dependency chain.
 * It orchestrates everything beneath it:
 *
 *   SubscriptionModule
 *     → InvoiceModule   (generates invoices)
 *     → BillingModule   (queues charges)
 *     → NotificationModule (sends emails)
 *     → UsageModule     (reset usage on renew — future)
 *
 * This is the cost of being the orchestrator. SubscriptionService
 * knows about all its dependencies. The layers beneath it know nothing
 * about each other — only SubscriptionService wires them together.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Subscription, Customer, Plan]),
    forwardRef(() => BillingModule),
    InvoiceModule,
    NotificationModule,
    UsageModule,
    IdempotencyModule
  ],
  controllers: [SubscriptionsController],
  providers: [SubscriptionService],
  exports: [SubscriptionService],
})
export class SubscriptionModule {}