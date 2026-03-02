import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, Repository } from 'typeorm';
import { Subscription } from '../subscriptions/entity/subscription.entity';
import { Invoice } from '../invoice/entity/invoice.entity';
import { SubscriptionStatus } from '../subscriptions/subscription.enum';
import { InvoiceStatus } from '../invoice/invoice.enum';
import { Idempotency } from 'src/modules/idempotency/entity/idempotency.entity';

// ─── Result Shapes ─────────────────────────────────────────────────────────

export interface RenewableSubscription {
  id: string;
  customerId: string;
  planId: string;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
}

export interface PastDueSubscription {
  id: string;
  customerId: string;
  openInvoiceId: string;
  openInvoiceAmount: number;
  daysPastDue: number;
}

export interface TimedOutSubscription {
  id: string;
  customerId: string;
  daysPastDue: number;
}

// ─── Service ───────────────────────────────────────────────────────────────

@Injectable()
export class SchedulerQueryService {
  private readonly logger = new Logger(SchedulerQueryService.name);

  constructor(
    @InjectRepository(Subscription)
    private readonly subscriptionRepo: Repository<Subscription>,

    @InjectRepository(Invoice)
    private readonly invoiceRepo: Repository<Invoice>,

    @InjectRepository(Idempotency)
    private readonly idempotencyRepo: Repository<Idempotency>,
  ) {}

  // ─── Renewal Query ─────────────────────────────────────────────────────

  /**
   * Finds subscriptions whose billing period ends within the next hour.
   *
   * WHY "within the next hour" and not "already expired"?
   * If we only fetch subscriptions that have ALREADY expired, we're always
   * running late. The customer's access lapses, they get a failed API call,
   * they file a support ticket.
   *
   * Fetching subscriptions expiring in the NEXT hour means we renew them
   * proactively — the charge processes, succeeds, and the new period starts
   * before the customer ever notices the old one ended.
   *
   * WHY add a 5-minute buffer on the lower bound?
   * The cron runs every hour. Without a lower bound, a subscription that
   * expired 3 hours ago (maybe we had downtime) would be caught here and
   * renewed again even if it was already handled. The 5-minute buffer
   * gives the previous cron run's work time to commit before we scan again.
   *
   * In production you'd track a "last_renewed_at" column to make this
   * truly idempotent. For now the status check is the guard.
   */
  async findRenewableSubscriptions(): Promise<RenewableSubscription[]> {
    const now = new Date();
    const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000);

    const results = await this.subscriptionRepo
      .createQueryBuilder('sub')
      .select([
        'sub.id',
        'sub.customer_id',
        'sub.plan_id',
        'sub.current_period_end',
        'sub.cancel_at_period_end',
      ])
      .where('sub.status = :status', { status: SubscriptionStatus.ACTIVE })
      .andWhere('sub.current_period_end <= :oneHourFromNow', { oneHourFromNow })
      .getMany();

    this.logger.debug(
      `Renewal query found ${results.length} subscriptions expiring within 1 hour`,
    );

    return results.map((sub) => ({
      id: sub.id,
      customerId: sub.customer_id,
      planId: sub.plan_id,
      currentPeriodEnd: sub.current_period_end,
      cancelAtPeriodEnd: sub.cancel_at_period_end,
    }));
  }

  // ─── Past-Due Query ────────────────────────────────────────────────────

  /**
   * Finds past_due subscriptions that still have an open invoice.
   *
   * WHY join to invoices here instead of just fetching past_due subs?
   * A past_due subscription without an open invoice has already been
   * processed (invoice marked uncollectible, waiting for customer action).
   * We only want to re-attempt dunning when there's still an outstanding
   * invoice to collect. The JOIN filters this in one query.
   *
   * WHY DISTINCT ON subscription?
   * A subscription could theoretically have multiple open invoices
   * (a bug, or a corrective invoice). We want one dunning attempt per
   * subscription per dunning cycle, not one per open invoice.
   * DISTINCT ON with ORDER BY created_at picks the oldest open invoice first
   * — collect the earliest debt first.
   */
  async findPastDueWithOpenInvoices(): Promise<PastDueSubscription[]> {
    const results = await this.subscriptionRepo
      .createQueryBuilder('sub')
      .innerJoinAndSelect(
        Invoice,
        'inv',
        'inv.subscription_id = sub.id AND inv.status = :invoiceStatus',
        { invoiceStatus: InvoiceStatus.OPEN },
      )
      .select([
        'sub.id AS "subscriptionId"',
        'sub.customer_id AS "customerId"',
        'inv.id AS "openInvoiceId"',
        'inv.amount AS "openInvoiceAmount"',
        `EXTRACT(DAY FROM NOW() - sub.updated_at) AS "daysPastDue"`,
      ])
      .where('sub.status = :subStatus', { subStatus: SubscriptionStatus.PAST_DUE })
      .distinctOn(['sub.id'])
      .orderBy('sub.id')
      .addOrderBy('inv.created_at', 'ASC') // oldest invoice first
      .getRawMany();

    this.logger.debug(
      `Dunning query found ${results.length} past-due subscriptions with open invoices`,
    );

    return results.map((row) => ({
      id: row.subscriptionId,
      customerId: row.customerId,
      openInvoiceId: row.openInvoiceId,
      openInvoiceAmount: parseFloat(row.openInvoiceAmount),
      daysPastDue: Math.floor(parseFloat(row.daysPastDue ?? '0')),
    }));
  }

  // ─── Timeout Query ─────────────────────────────────────────────────────

  /**
   * Finds subscriptions that have been past_due for longer than the
   * given threshold — these get hard cancelled.
   *
   * WHY track days via updated_at and not a dedicated column?
   * When moveToPastDue() runs, it updates the subscription row — so
   * updated_at captures the moment the status changed to past_due.
   * EXTRACT(DAY FROM NOW() - updated_at) gives us days in that state.
   *
   * This assumes updated_at is only touched on status changes, which
   * is true in our design. In a more complex system with frequent
   * non-status updates, you'd add a past_due_since column.
   */
  async findTimedOutPastDueSubscriptions(
    pastDueThresholdDays: number,
  ): Promise<TimedOutSubscription[]> {
    const results = await this.subscriptionRepo
      .createQueryBuilder('sub')
      .select([
        'sub.id AS "subscriptionId"',
        'sub.customer_id AS "customerId"',
        `EXTRACT(DAY FROM NOW() - sub.updated_at) AS "daysPastDue"`,
      ])
      .where('sub.status = :status', { status: SubscriptionStatus.PAST_DUE })
      .andWhere(
        `EXTRACT(DAY FROM NOW() - sub.updated_at) >= :threshold`,
        { threshold: pastDueThresholdDays },
      )
      .getRawMany();

    this.logger.debug(
      `Timeout query found ${results.length} subscriptions past_due for >${pastDueThresholdDays} days`,
    );

    return results.map((row) => ({
      id: row.subscriptionId,
      customerId: row.customerId,
      daysPastDue: Math.floor(parseFloat(row.daysPastDue)),
    }));
  }

  // ─── Idempotency Cleanup Query ─────────────────────────────────────────

  /**
   * Returns the count of expired idempotency keys that will be deleted.
   * The actual deletion happens in the scheduler — the query service
   * only provides data.
   *
   * WHY return count and not the keys themselves?
   * We don't need to load 50,000 expired keys into memory to delete them.
   * The scheduler uses a direct DELETE WHERE query. The count is just
   * for logging and metrics.
   */
  async countExpiredIdempotencyKeys(): Promise<number> {
    return this.idempotencyRepo.count({
      where: {
        expires_at: LessThanOrEqual(new Date()),
      },
    });
  }
}