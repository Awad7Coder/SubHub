import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { LogUsageDto, GetUsageQueryDto } from '../usage/dto/usage.dto';
import { UsageLimitGuard, UsageAction } from '../../common/guards/usageLimit.guard';
import { UsageService } from './usage.service';

@Controller('usage')
export class UsageController {
  constructor(private readonly usageService: UsageService) {}

  // ── POST /api/usage/:subscriptionId ────────────────────────────────────

  /**
   * Logs a usage event for a subscription.
   *
   * WHY no idempotency on the usage log endpoint?
   * Usage logging is intentionally NOT idempotent at the HTTP level.
   * If a client logs "api_call" twice, that's two API calls consumed.
   * The client is responsible for not double-logging.
   *
   * Contrast with payments: accidental double-payment = customer charged twice.
   * Accidental double-log = customer uses 2 credits instead of 1.
   * The consequences are asymmetric — idempotency is critical for payments,
   * acceptable-risk for usage events.
   *
   * WHY @HttpCode(204) and not 201?
   * 201 Created means "a new resource was created that you can navigate to."
   * A usage log entry has no URL, no GET endpoint, no identity from the client's
   * perspective. 204 No Content = "operation succeeded, nothing to return."
   * This is the correct semantic for fire-and-forget logging.
   */
  @Post(':subscriptionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logUsage(
    @Param('subscriptionId', ParseUUIDPipe) subscriptionId: string,
    @Body() dto: LogUsageDto,
  ) {
    await this.usageService.logUsage({
      subscriptionId,
      actionType: dto.actionType,
      amountUsed: dto.amountUsed,
      metadata: dto.metadata,
    });
    // WHY return nothing? 204 No Content means the response body is empty.
    // Returning the saved entity would require a 201. Pick one and be consistent.
  }

  // ── GET /api/usage/:subscriptionId/summary ─────────────────────────────

  /**
   * Returns usage summary for the current billing period.
   *
   * WHY @UseGuards(UsageLimitGuard) + @UsageAction('api_call') here?
   * Fetching a usage report is itself an API call that consumes credits
   * on metered plans. This demonstrates the guard working on a GET endpoint.
   *
   * In reality: you'd probably exempt certain management endpoints from
   * usage counting (or use a different actionType like 'management_api').
   * The decorator makes the choice explicit and changeable per-route.
   */
  @Get(':subscriptionId/summary')
  @UseGuards(UsageLimitGuard)
  @UsageAction('api_call')
  async getSummary(
    @Param('subscriptionId', ParseUUIDPipe) subscriptionId: string,
    @Query() query: GetUsageQueryDto,
  ) {
    return this.usageService.getUsageSummary(subscriptionId, query.actionType);
  }

  // ── GET /api/usage/:subscriptionId/current ─────────────────────────────

  /**
   * Returns the raw usage count for the current period.
   * Lighter than /summary — just a number, no derived fields.
   * Useful for quick limit-checking from a frontend before attempting an action.
   */
  @Get(':subscriptionId/current')
  async getCurrentUsage(
    @Param('subscriptionId', ParseUUIDPipe) subscriptionId: string,
    @Query() query: GetUsageQueryDto,
  ) {
    /**
     * WHY fetch the subscription here to get periodStart?
     * getCurrentUsage needs periodStart to scope the COUNT query.
     * In a real implementation, UsageService.getCurrentUsageForSubscription()
     * would encapsulate this lookup. For now we delegate to getUsageSummary
     * and return the relevant fields. Refactor when the need arises.
     */
    const summary = await this.usageService.getUsageSummary(
      subscriptionId,
      query.actionType,
    );

    return {
      subscriptionId,
      actionType: query.actionType ?? null,
      currentUsage: summary.currentUsage,
      usageLimit: summary.usageLimit,
      isUnlimited: summary.isUnlimited,
      periodStart: summary.periodStart,
      periodEnd: summary.periodEnd,
    };
  }
}