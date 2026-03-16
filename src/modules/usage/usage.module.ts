import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { UsageService } from './usage.service';
import { UsageLimitGuard } from 'src/common/guards/usageLimit.guard';
import { UsageLog } from './entity/usage-log.entity';
import { Subscription } from '../subscriptions/entity/subscription.entity';

/**
 * WHY export both UsageService and UsageLimitGuard?
 *
 * UsageService: BillingScheduler (Layer 4) needs getSubscriptionsNearLimit()
 *               to run the 80% warning cron job.
 *
 * UsageLimitGuard: Any feature module (reports, exports, API endpoints)
 *                  can import UsageModule and use @UseGuards(UsageLimitGuard)
 *                  without re-declaring the guard logic.
 */
@Module({
  imports: [TypeOrmModule.forFeature([UsageLog, Subscription])],
  providers: [UsageService, UsageLimitGuard],
  exports: [UsageService, UsageLimitGuard],
})
export class UsageModule {}