import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { HealthController } from './health.controller';
import { BILLING_JOBS } from '../subscriptions/subscription.enum';

/**
 * WHY import BullModule here without registering a new queue?
 * BullModule.registerQueue() was already called in BillingModule.
 * Here we just need access to the existing queue instance for the
 * health check. registerQueue() is idempotent in NestJS —
 * it returns the existing queue if already registered.
 */
@Module({
  imports: [
    BullModule.registerQueue({ name: BILLING_JOBS.CHARGE_INVOICE }),
  ],
  controllers: [HealthController],
})
export class HealthModule {}