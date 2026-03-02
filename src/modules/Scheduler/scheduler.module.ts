import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BillingScheduler } from './billing.scheduler';

import { BillingModule } from '../billing/billing.module';
import { UsageModule } from '../usage/usage.module';
import { Subscription } from '../subscriptions/entity/subscription.entity';
import { Invoice } from '../invoice/entity/invoice.entity';
import { Idempotency } from 'src/modules/idempotency/entity/idempotency.entity';
import { SubscriptionModule } from '../subscriptions/subscriptions.module';
import { NotificationModule } from '../notifications/notifications.module';
import { SchedulerQueryService } from './scheduler.quary';

/**
 * WHY ScheduleModule.forRoot() here and not in AppModule?
 *
 * forRoot() initializes the cron engine once for the entire app.
 * It CAN go in AppModule, and many tutorials put it there.
 *
 * Putting it in SchedulerModule is better because:
 * - SchedulerModule is self-contained — import it anywhere and crons work
 * - AppModule stays clean — it just imports SchedulerModule
 * - If you extract the scheduler to its own microservice later,
 *   you move one module, not hunt through AppModule for the setup
 *
 * ScheduleModule.forRoot() is idempotent — calling it multiple times
 * in different modules is safe (NestJS deduplicates global module setup).
 */
@Module({
  imports: [
    ScheduleModule.forRoot(),

    // Entities the SchedulerQueryService queries directly
    TypeOrmModule.forFeature([Subscription, Invoice, Idempotency]),

    // Feature modules — import these to get their exported services
    SubscriptionModule,
    BillingModule,
    UsageModule,
    NotificationModule,
  ],
  providers: [BillingScheduler, SchedulerQueryService],
})
export class SchedulerModule {}