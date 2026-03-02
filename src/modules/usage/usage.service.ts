import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  SubscriptionNotFoundException,
  UsageLimitExceededException,
} from '../../common/exceptions/domain.exception';
import { UsageLog } from './entity/usage-log.entity';
import { Subscription } from '../subscriptions/entity/subscription.entity';

// ─── DTOs ──────────────────────────────────────────────────────────────────

export interface LogUsageDto {
  subscriptionId: string;
  actionType: string;
  amountUsed?: number;
  metadata?: Record<string, any>;
}

export interface UsageSummary {
  subscriptionId: string;
  actionType: string | null;
  currentUsage: number;
  usageLimit: number;
  percentUsed: number;
  periodStart: Date;
  periodEnd: Date;
  isUnlimited: boolean; 
}

// ─── Constants ─────────────────────────────────────────────────────────────

const USAGE_WARNING_THRESHOLD_PERCENT = 80;
const UNLIMITED_USAGE_SENTINEL = 0;

// ─── Service ───────────────────────────────────────────────────────────────

@Injectable()
export class UsageService {
  private readonly logger = new Logger(UsageService.name);

  constructor(
    @InjectRepository(UsageLog)
    private readonly usageLogRepo: Repository<UsageLog>,

    @InjectRepository(Subscription)
    private readonly subscriptionRepo: Repository<Subscription>,
  ) {}

  // ─── Log Usage ───────────────────────────────────────────────────────────

  async logUsage(dto: LogUsageDto): Promise<UsageLog> {
    const log = this.usageLogRepo.create({
      subscription_id: dto.subscriptionId,
      action_type: dto.actionType,
      amount_used: dto.amountUsed ?? 1,
      metadata: dto.metadata,
    });

    const saved = await this.usageLogRepo.save(log);

    this.logger.debug(
      `Usage logged: ${dto.actionType} x${dto.amountUsed ?? 1} for subscription ${dto.subscriptionId}`,
    );

    return saved;
  }

  // ─── Check and Enforce ───────────────────────────────────────────────────

  async checkAndEnforce(subscriptionId: string, actionType: string): Promise<void> {
    const subscription = await this.subscriptionRepo.findOne({
      where: { id: subscriptionId },
      relations: ['plan'],
    });

    if (!subscription) {
      throw new SubscriptionNotFoundException(subscriptionId);
    }

    const usageLimit = subscription.plan.usage_limit;

    if (usageLimit === UNLIMITED_USAGE_SENTINEL) {
      this.logger.debug(
        `Subscription ${subscriptionId} is on unlimited plan — skipping usage check`,
      );
      return;
    }

    const currentUsage = await this.getCurrentUsage(
      subscriptionId,
      subscription.current_period_start,
      actionType,
    );

    if (currentUsage >= usageLimit) {
      this.logger.warn(
        `Usage limit hit: subscription ${subscriptionId}, action ${actionType}, ${currentUsage}/${usageLimit}`,
      );

      throw new UsageLimitExceededException(
        subscriptionId,
        actionType,
        currentUsage,
        usageLimit,
      );
    }

    this.logger.debug(
      `Usage check passed: ${actionType} ${currentUsage}/${usageLimit} for subscription ${subscriptionId}`,
    );
  }

  // ─── Get Current Usage ───────────────────────────────────────────────────

  async getCurrentUsage(
    subscriptionId: string,
    periodStart: Date,
    actionType?: string,
  ): Promise<number> {
    const qb = this.usageLogRepo
      .createQueryBuilder('log')
      .select('COALESCE(SUM(log.amount_used), 0)', 'total')
      .where('log.subscription_id = :subscriptionId', { subscriptionId })
      .andWhere('log.recorded_at >= :periodStart', { periodStart });

    if (actionType) {
      qb.andWhere('log.action_type = :actionType', { actionType });
    }

    const result = await qb.getRawOne<{ total: string }>();

    return parseFloat(result?.total ?? '0');
  }

  // ─── Get Usage Summary ───────────────────────────────────────────────────

  async getUsageSummary(
    subscriptionId: string,
    actionType?: string,
  ): Promise<UsageSummary> {
    const subscription = await this.subscriptionRepo.findOne({
      where: { id: subscriptionId },
      relations: ['plan'],
    });

    if (!subscription) {
      throw new SubscriptionNotFoundException(subscriptionId);
    }

    const usageLimit = subscription.plan.usage_limit;
    const isUnlimited = usageLimit === UNLIMITED_USAGE_SENTINEL;

    const currentUsage = await this.getCurrentUsage(
      subscriptionId,
      subscription.current_period_start,
      actionType,
    );

    const percentUsed = isUnlimited ? 0 : (currentUsage / usageLimit) * 100;

    return {
      subscriptionId,
      actionType: actionType ?? null,
      currentUsage,
      usageLimit,
      percentUsed: Math.round(percentUsed * 100) / 100,
      periodStart: subscription.current_period_start,
      periodEnd: subscription.current_period_end,
      isUnlimited,
    };
  }

  // ─── Warning Check (for Cron Job) ────────────────────────────────────────

  async getSubscriptionsNearLimit(
    thresholdPercent: number = USAGE_WARNING_THRESHOLD_PERCENT,
  ): Promise<Array<{ subscriptionId: string; percentUsed: number; actionType: string }>> {
    const result = await this.usageLogRepo
      .createQueryBuilder('log')
      .select('log.subscription_id', 'subscriptionId')
      .addSelect('log.action_type', 'actionType')
      .addSelect('COALESCE(SUM(log.amount_used), 0)', 'currentUsage')
      .innerJoin('log.subscription', 'sub')
      .innerJoin('sub.plan', 'plan')
      .addSelect('plan.usage_limit', 'usageLimit')
      .where('sub.status = :status', { status: 'active' })
      .andWhere('plan.usage_limit > 0')
      .andWhere('log.recorded_at >= sub.current_period_start')
      .groupBy('log.subscription_id')
      .addGroupBy('log.action_type')
      .addGroupBy('plan.usage_limit')
      .addGroupBy('sub.current_period_start')
      .having(
        '(COALESCE(SUM(log.amount_used), 0) / plan.usage_limit) * 100 >= :threshold',
        { threshold: thresholdPercent },
      )
      .getRawMany();

    return result.map((row) => ({
      subscriptionId: row.subscriptionId,
      actionType: row.actionType,
      percentUsed:
        Math.round(
          (parseFloat(row.currentUsage) / parseFloat(row.usageLimit)) * 10000,
        ) / 100,
    }));
  }
}