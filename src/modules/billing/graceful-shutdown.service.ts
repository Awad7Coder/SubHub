import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { BILLING_JOBS } from '../subscriptions/subscription.enum';

/**
 * WHY a dedicated shutdown service instead of putting this in BillingProcessor?
 *
 * BillingProcessor handles job execution.
 * GracefulShutdownService handles the lifecycle boundary.
 * Mixing them couples transport with lifecycle management.
 *
 * More importantly: NestJS calls onModuleDestroy() on all providers
 * that implement it during shutdown. By registering this as a provider
 * in BillingModule, it automatically participates in the shutdown sequence.
 *
 * SHUTDOWN SEQUENCE with this in place:
 *
 *   SIGTERM received
 *     ↓
 *   app.enableShutdownHooks() triggers NestJS shutdown
 *     ↓
 *   NestJS calls onModuleDestroy() on all modules
 *     ↓
 *   GracefulShutdownService.onModuleDestroy():
 *     - Closes the queue (stops accepting new jobs)
 *     - BullMQ worker finishes current job then exits
 *     ↓
 *   TypeORM connection pool closes
 *     ↓
 *   Process exits cleanly (code 0)
 *
 * Total window: whatever terminationGracePeriodSeconds allows (default 30s).
 * A single BullMQ charge job typically takes 2-3 seconds.
 * 30 seconds is more than enough.
 */
@Injectable()
export class GracefulShutdownService implements OnModuleDestroy {
  private readonly logger = new Logger(GracefulShutdownService.name);

  constructor(
    @InjectQueue(BILLING_JOBS.CHARGE_INVOICE)
    private readonly billingQueue: Queue,
  ) {}

  async onModuleDestroy(): Promise<void> {
    this.logger.log('Graceful shutdown initiated — draining BullMQ queues...');

    try {
      /**
       * WHY close() instead of pause()?
       *
       * pause(): stops picking up NEW jobs but keeps the worker process
       * alive — useful for temporary maintenance, not shutdown.
       *
       * close(): signals the worker to finish its current job and then
       * close the Redis connection. This is what you want on SIGTERM.
       *
       * The boolean argument `force`:
       *   false (default): wait for current job to complete before closing
       *   true: close immediately even if a job is in progress
       *
       * Always use false in production — never orphan an in-flight charge.
       */
      await this.billingQueue.close();
      this.logger.log('BullMQ billing queue closed cleanly');
    } catch (error) {
      this.logger.error(`Error closing BullMQ queue: ${error.message}`);
      // Don't re-throw — let the shutdown continue even if queue close fails
    }
  }
}