import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ForbiddenException,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { UsageLimitExceededException } from '../../common/exceptions/domain.exception';
import { UsageService } from 'src/modules/usage/usage.service';

/**
 * WHY a custom decorator alongside the guard?
 *
 * Guards alone can't know WHICH action type to enforce — that's
 * context-specific to each route. The decorator lets controllers
 * declare this metadata:
 *
 *   @UseGuards(UsageLimitGuard)
 *   @UsageAction('api_call')
 *   @Post('/reports/generate')
 *   async generateReport() { ... }
 *
 * The guard reads the metadata and knows to check 'api_call' usage.
 * This is the NestJS metadata pattern — clean, declarative, zero
 * business logic in your controllers.
 */
export const USAGE_ACTION_KEY = 'usage_action';
export const UsageAction = (actionType: string) =>
  SetMetadata(USAGE_ACTION_KEY, actionType);

// ─── Guard ─────────────────────────────────────────────────────────────────

@Injectable()
export class UsageLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly usageService: UsageService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    /**
     * WHY read metadata from the handler first, then the class?
     * NestJS allows decorators at both method and controller level.
     * getAllAndOverride checks method first (more specific) then class
     * (more general). Method-level always wins.
     */
    const actionType = this.reflector.getAllAndOverride<string>(USAGE_ACTION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    /**
     * WHY return true if no actionType is defined?
     * Not every route needs usage enforcement. If the @UsageAction
     * decorator isn't present, this guard is a no-op and lets the
     * request through. This makes the guard opt-in per route.
     */
    if (!actionType) {
      return true;
    }

    const request = context.switchToHttp().getRequest();

    /**
     * WHY read subscriptionId from request.user?
     * This assumes your auth middleware has already validated the JWT
     * and attached the user/subscription context to the request.
     * The guard is the LAST line of defense, not the first.
     * Auth guard runs first → attaches user → usage guard runs second.
     */
    const subscriptionId: string | undefined = request.user?.subscriptionId;

    if (!subscriptionId) {
      /**
       * WHY not throw UsageLimitExceededException here?
       * Missing subscriptionId is an auth/context problem, not a usage problem.
       * Return true and let the controller handle unauthenticated access
       * via its own auth guard. Don't conflate concerns.
       */
      return true;
    }

    try {
      await this.usageService.checkAndEnforce(subscriptionId, actionType);
      return true;
    } catch (error) {
      if (error instanceof UsageLimitExceededException) {
        /**
         * WHY convert to ForbiddenException here and not in the service?
         * The service throws a domain exception (UsageLimitExceededException).
         * The guard lives in the HTTP transport layer and converts it to
         * an HTTP exception. This is the boundary where domain meets transport.
         *
         * WHY include current/limit in the response?
         * "You've hit your limit" is frustrating. "You've used 100/100
         * api_calls this month. Upgrade to Pro for unlimited." is actionable.
         */
        throw new ForbiddenException({
          message: `Usage limit exceeded for '${error.actionType}'`,
          current: error.current,
          limit: error.limit,
          actionType: error.actionType,
          upgradeUrl: '/billing/upgrade', // make this configurable in production
        });
      }

      // Re-throw anything unexpected — don't swallow unknown errors
      throw error;
    }
  }
}