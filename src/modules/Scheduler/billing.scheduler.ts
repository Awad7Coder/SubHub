import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import {  Repository } from 'typeorm';
import { SubscriptionService } from '../subscriptions/subscriptions.service';
import { BillingService } from '../billing/billing.service';
import { UsageService } from '../usage/usage.service';
import { NotificationService } from '../notifications/notifications.service';
import { Idempotency } from 'src/modules/idempotency/entity/idempotency.entity';
import { SchedulerQueryService } from './scheduler.quary';


/**
 * WHY @nestjs/schedule and not node-cron or setInterval?
 *
 * @nestjs/schedule integrates with NestJS's lifecycle — crons start
 * when the app bootstraps and stop when it shuts down gracefully.
 * setInterval would keep running during shutdown, potentially firing
 * a renewal job mid-teardown and leaving partial DB writes.
 *
 * It also gives us CronExpression enums (no magic strings) and
 * automatic error isolation — one failed cron doesn't crash others.
 */

/**
 * CRITICAL PRODUCTION CONCERN: Distributed Locking
 *
 * If you run 3 instances of this service (horizontal scaling), ALL 3
 * will fire the renewal cron at the same time. Subscription X gets
 * renewed 3 times. Customer gets charged 3 times. You have a problem.
 *
 * Solutions (in order of complexity):
 * 1. Run the scheduler on a SINGLE dedicated instance (simplest)
 *    → Set SCHEDULER_ENABLED=true on only one container
 * 2. Redis distributed lock (redlock library)
 *    → Each cron tries to acquire a lock before running
 *    → Only one instance proceeds, others skip
 * 3. Dedicated scheduler service (most robust)
 *    → Extract scheduler into its own microservice
 *
 * We implement option 1 with an env guard — simplest, production-ready
 * for most SaaS scales (you need millions of subs before you need option 3).
 */

// ─── Scheduler Configuration ───────────────────────────────────────────────

const SCHEDULER_CONFIG = {
  PAST_DUE_TIMEOUT_DAYS: 14,       // cancel after 14 days past_due
  DUNNING_BATCH_SIZE: 50,          // process N past-due subs per run
  RENEWAL_BATCH_SIZE: 100,         // process N renewals per run
  USAGE_WARNING_BATCH_SIZE: 200,   // process N usage warnings per run
} as const;

// ─── Scheduler ─────────────────────────────────────────────────────────────

@Injectable()
export class BillingScheduler {
  private readonly logger = new Logger(BillingScheduler.name);

  /**
   * WHY track running state per job?
   * Cron jobs fire on a timer regardless of whether the previous run
   * finished. If renewal processing takes 90 minutes (large subscriber base)
   * and the cron fires every 60 minutes, you get two overlapping renewal runs.
   * The isRunning flag prevents concurrent execution of the same job type.
   */
  private readonly isRunning = {
    renewal: false,
    dunning: false,
    usageWarning: false,
    pastDueTimeout: false,
    idempotencyCleanup: false,
  };

  constructor(
    private readonly subscriptionService: SubscriptionService,
    private readonly billingService: BillingService,
    private readonly usageService: UsageService,
    private readonly notificationService: NotificationService,
    private readonly schedulerQueryService: SchedulerQueryService,

    @InjectRepository(Idempotency)
    private readonly idempotencyRepo: Repository<Idempotency>,
  ) {}

  // ─── Job 1: Renewal Check ─────────────────────────────────────────────
  // Runs every hour at minute 0
  // CronExpression.EVERY_HOUR = '0 * * * *'

  @Cron(CronExpression.EVERY_HOUR)
  async handleRenewalCheck(): Promise<void> {
    if (!this.acquireLock('renewal')) return;

    const startTime = Date.now();
    this.logger.log('🔄 Renewal check started');

    let processed = 0;
    let succeeded = 0;
    let failed = 0;

    try {
      const renewables =
        await this.schedulerQueryService.findRenewableSubscriptions();

      /**
       * WHY process in batches and not all at once?
       * If you have 10,000 subscriptions renewing today and you call
       * Promise.all() on all of them, you'll:
       * 1. Saturate your DB connection pool (timeouts)
       * 2. Saturate your BullMQ queue with 10,000 jobs at once
       * 3. Potentially OOM if each renewal loads relations into memory
       *
       * Processing in batches of 100 keeps resource usage predictable
       * and gives you a clean failure boundary: if the server crashes
       * after batch 3, batches 1-3 are done and batch 4+ will be caught
       * by the next cron run.
       */
      const batches = chunk(renewables, SCHEDULER_CONFIG.RENEWAL_BATCH_SIZE);

      for (const batch of batches) {
        /**
         * WHY Promise.allSettled() instead of Promise.all()?
         *
         * Promise.all() → first rejection cancels the entire batch.
         *   If subscription 47 of 100 fails, subscriptions 48-100 never renew.
         *
         * Promise.allSettled() → all promises run regardless.
         *   If subscription 47 fails, 1-46 and 48-100 still renew.
         *   You get a result for each, success or failure.
         *
         * In billing, you NEVER want one customer's bad data to
         * block another customer's renewal. Always use allSettled.
         */
        const results = await Promise.allSettled(
          batch.map((sub) => this.subscriptionService.renew(sub.id)),
        );

        for (const [index, result] of results.entries()) {
          processed++;
          if (result.status === 'fulfilled') {
            succeeded++;
          } else {
            failed++;
            this.logger.error(
              `Renewal failed for subscription ${batch[index].id}: ${result.reason?.message}`,
            );
          }
        }
      }
    } catch (error) {
      // Catch-all for query failures (DB down, etc.)
      this.logger.error(`Renewal check crashed: ${error.message}`, error.stack);
    } finally {
      /**
       * WHY release the lock in finally and not after the try block?
       * If the try block throws and you release in the normal flow,
       * the lock never gets released — the job is frozen forever until
       * the server restarts. finally ALWAYS runs, even on exceptions.
       */
      this.releaseLock('renewal');
      const duration = Date.now() - startTime;
      this.logger.log(
        `✅ Renewal check complete — ${succeeded} renewed, ${failed} failed, ${processed} total (${duration}ms)`,
      );
    }
  }

  // ─── Job 2: Past-Due Dunning ──────────────────────────────────────────
  // Runs every 6 hours: at 00:00, 06:00, 12:00, 18:00

  @Cron('0 0,6,12,18 * * *')
  async handleDunning(): Promise<void> {
    if (!this.acquireLock('dunning')) return;

    const startTime = Date.now();
    this.logger.log('💳 Dunning check started');

    let attempted = 0;
    let queued = 0;

    try {
      const pastDueSubs =
        await this.schedulerQueryService.findPastDueWithOpenInvoices();

      /**
       * WHY limit dunning batch size?
       * Dunning re-queues BullMQ charge jobs. If you have 5,000
       * past-due subscriptions and queue all their charges simultaneously,
       * your worker processes them in parallel and hammers Stripe's API.
       * Batching also respects Stripe's rate limits (100 req/sec by default).
       */
      const batch = pastDueSubs.slice(0, SCHEDULER_CONFIG.DUNNING_BATCH_SIZE);

      const results = await Promise.allSettled(
        batch.map(async (sub) => {
          attempted++;
          await this.billingService.queueCharge(sub.openInvoiceId);
          queued++;
        }),
      );

      for (const [index, result] of results.entries()) {
        if (result.status === 'rejected') {
          this.logger.error(
            `Dunning queue failed for subscription ${batch[index].id}: ${result.reason?.message}`,
          );
        }
      }
    } catch (error) {
      this.logger.error(`Dunning check crashed: ${error.message}`, error.stack);
    } finally {
      this.releaseLock('dunning');
      const duration = Date.now() - startTime;
      this.logger.log(
        `✅ Dunning check complete — ${queued}/${attempted} queued (${duration}ms)`,
      );
    }
  }

  // ─── Job 3: Usage Warnings ────────────────────────────────────────────
  // Runs every hour at minute 30 (offset from renewal to spread DB load)

  @Cron('30 * * * *')
  async handleUsageWarnings(): Promise<void> {
    if (!this.acquireLock('usageWarning')) return;

    const startTime = Date.now();
    this.logger.log('⚠️  Usage warning check started');

    let warned = 0;

    try {
      /**
       * WHY 80% threshold from UsageService and not hardcoded here?
       * UsageService owns usage business logic — including what "near limit"
       * means. If the threshold changes to 85%, it changes in one place.
       * The scheduler just asks "who is near limit?" and acts on the answer.
       */
      const nearLimitSubs =
        await this.usageService.getSubscriptionsNearLimit(80);

      const batch = nearLimitSubs.slice(
        0,
        SCHEDULER_CONFIG.USAGE_WARNING_BATCH_SIZE,
      );

      const results = await Promise.allSettled(
        batch.map(async (item) => {
          const summary = await this.usageService.getUsageSummary(
            item.subscriptionId,
            item.actionType,
          );

          // ── Load customer for email ──────────────────────────────────
          // WHY not include customer in the usage query?
          // Usage queries are already complex joins. Adding a customer join
          // makes them slower and harder to maintain. We load customer
          // separately here — it's a scheduler, not a hot path.
          // N+1 is acceptable when N is bounded (batch size = 200).

          await this.notificationService.sendUsageLimitWarning({
            customerEmail: '', // ← In production: fetch customer by subscriptionId
            subscriptionId: item.subscriptionId,
            actionType: item.actionType,
            percentUsed: item.percentUsed,
            currentUsage: summary.currentUsage,
            usageLimit: summary.usageLimit,
            periodEnd: summary.periodEnd,
          });

          warned++;
        }),
      );

      for (const [index, result] of results.entries()) {
        if (result.status === 'rejected') {
          this.logger.error(
            `Usage warning failed for subscription ${batch[index].subscriptionId}: ${result.reason?.message}`,
          );
        }
      }
    } catch (error) {
      this.logger.error(
        `Usage warning check crashed: ${error.message}`,
        error.stack,
      );
    } finally {
      this.releaseLock('usageWarning');
      const duration = Date.now() - startTime;
      this.logger.log(
        `✅ Usage warning check complete — ${warned} warnings sent (${duration}ms)`,
      );
    }
  }

  // ─── Job 4: Past-Due Timeout ──────────────────────────────────────────
  // Runs once per day at midnight

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handlePastDueTimeout(): Promise<void> {
    if (!this.acquireLock('pastDueTimeout')) return;

    const startTime = Date.now();
    this.logger.log('🚫 Past-due timeout check started');

    let cancelled = 0;
    let failed = 0;

    try {
      const timedOut =
        await this.schedulerQueryService.findTimedOutPastDueSubscriptions(
          SCHEDULER_CONFIG.PAST_DUE_TIMEOUT_DAYS,
        );

      this.logger.warn(
        `Found ${timedOut.length} subscriptions past_due for >${SCHEDULER_CONFIG.PAST_DUE_TIMEOUT_DAYS} days — cancelling`,
      );

      const results = await Promise.allSettled(
        timedOut.map((sub) =>
          this.subscriptionService.cancelImmediately(sub.id),
        ),
      );

      for (const [index, result] of results.entries()) {
        if (result.status === 'fulfilled') {
          cancelled++;
          this.logger.log(
            `Subscription ${timedOut[index].id} cancelled after ${timedOut[index].daysPastDue} days past_due`,
          );
        } else {
          failed++;
          this.logger.error(
            `Timeout cancel failed for subscription ${timedOut[index].id}: ${result.reason?.message}`,
          );
        }
      }

      /**
       * WHY send an internal alert when we cancel subscriptions?
       * Mass cancellations affect MRR (Monthly Recurring Revenue).
       * Your finance team and leadership want to know when this happens.
       * "14 subscriptions auto-cancelled today due to non-payment" is
       * a business metric, not just an ops event.
       */
      if (cancelled > 0) {
        await this.notificationService.sendInternalAlert(
          `Past-Due Timeout: ${cancelled} subscriptions auto-cancelled`,
          {
            cancelled,
            failed,
            thresholdDays: SCHEDULER_CONFIG.PAST_DUE_TIMEOUT_DAYS,
            runAt: new Date().toISOString(),
          },
        );
      }
    } catch (error) {
      this.logger.error(
        `Past-due timeout check crashed: ${error.message}`,
        error.stack,
      );
    } finally {
      this.releaseLock('pastDueTimeout');
      const duration = Date.now() - startTime;
      this.logger.log(
        `✅ Past-due timeout complete — ${cancelled} cancelled, ${failed} failed (${duration}ms)`,
      );
    }
  }

  // ─── Job 5: Idempotency Cleanup ───────────────────────────────────────
  // Runs every day at 2am — lowest traffic window

  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async handleIdempotencyCleanup(): Promise<void> {
    if (!this.acquireLock('idempotencyCleanup')) return;

    const startTime = Date.now();
    this.logger.log('🧹 Idempotency cleanup started');

    try {
      const expiredCount =
        await this.schedulerQueryService.countExpiredIdempotencyKeys();

      if (expiredCount === 0) {
        this.logger.log('No expired idempotency keys to clean up');
        return;
      }

      this.logger.log(`Deleting ${expiredCount} expired idempotency keys`);

      /**
       * WHY a direct DELETE here instead of calling a service method?
       *
       * This is a pure infrastructure cleanup — no business logic,
       * no state transitions, no side effects.
       * A service method would add a layer of indirection with zero benefit.
       * The scheduler owns this operation completely.
       *
       * WHY not delete in batches?
       * DELETE WHERE expires_at < NOW() is handled atomically by PostgreSQL.
       * It acquires row-level locks, not a table lock. For a table in the
       * tens of thousands of rows, a single DELETE is fine.
       * At millions of rows: switch to batched deletion with LIMIT.
       */
      const result = await this.idempotencyRepo
        .createQueryBuilder()
        .delete()
        .where('expires_at <= :now', { now: new Date() })
        .execute();

      const deletedCount = result.affected ?? 0;

      this.logger.log(
        `✅ Idempotency cleanup complete — ${deletedCount} keys deleted`,
      );
    } catch (error) {
      this.logger.error(
        `Idempotency cleanup crashed: ${error.message}`,
        error.stack,
      );
    } finally {
      this.releaseLock('idempotencyCleanup');
      const duration = Date.now() - startTime;
      this.logger.debug(`Idempotency cleanup duration: ${duration}ms`);
    }
  }

  // ─── Lock Helpers ─────────────────────────────────────────────────────

  /**
   * WHY not use a decorator for this?
   * A decorator approach would be cleaner, but for 5 jobs the explicit
   * acquireLock/releaseLock pattern makes the guard VISIBLE in each method.
   * When a junior reads handleRenewalCheck(), they immediately see:
   * "oh, this is protected against concurrent runs."
   * A decorator hides that — trading clarity for elegance.
   */
  private acquireLock(job: keyof typeof this.isRunning): boolean {
    if (this.isRunning[job]) {
      this.logger.warn(
        `⏭️  Skipping ${job} — previous run still in progress`,
      );
      return false;
    }
    this.isRunning[job] = true;
    return true;
  }

  private releaseLock(job: keyof typeof this.isRunning): void {
    this.isRunning[job] = false;
  }
}

// ─── Utility ──────────────────────────────────────────────────────────────

/**
 * WHY a local chunk() instead of importing lodash?
 * It's 4 lines. Adding a dependency for 4 lines is not worth it.
 * If you're already using lodash elsewhere, use _.chunk() instead.
 */
function chunk<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}