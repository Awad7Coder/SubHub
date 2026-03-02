import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';

import { BillingService } from './billing.service';

import { BILLING_JOBS } from '../subscriptions/subscription.enum';
import { Customer } from '../customers/entity/customer.entity';
import { Invoice } from '../invoice/entity/invoice.entity';
import { Payment } from '../payments/entity/payment.entity';
import { BillingProcessor } from './Billing.processor';
import { NotificationModule } from '../notifications/notifications.module';
import { InvoiceModule } from '../invoice/invoice.module';
import { SubscriptionModule } from '../subscriptions/subscriptions.module';

/**
 * WHY register the queue in BillingModule specifically?
 *
 * The queue is billing infrastructure. SubscriptionService uses
 * BillingService.queueCharge() — it never touches the queue directly.
 * Centralizing the queue registration in BillingModule means one place
 * owns the queue configuration (concurrency, connection, prefix).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Payment, Invoice, Customer]),
    forwardRef(() => SubscriptionModule),
    BullModule.registerQueue({
      name: BILLING_JOBS.CHARGE_INVOICE,
      /**
       * WHY set defaultJobOptions here and not in each add() call?
       * Queue-level defaults apply to every job unless overridden.
       * This is your safety net: even if a developer forgets to set
       * removeOnComplete on a new job type, the default kicks in.
       */
      defaultJobOptions: {
        removeOnComplete: 100, // keep last 100 completed jobs for debugging
        removeOnFail: 500,     // keep last 500 failed jobs for inspection
        attempts: 1,           // we manage retries manually in BillingService
      },
    }),
    InvoiceModule,
    NotificationModule,
  ],
  providers: [BillingService, BillingProcessor],
  exports: [BillingService],
})
export class BillingModule {}