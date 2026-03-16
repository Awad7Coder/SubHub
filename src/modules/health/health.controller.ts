import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  ServiceUnavailableException,
  Logger,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { DataSource } from 'typeorm';
import { Queue } from 'bullmq';
import { BILLING_JOBS } from '../subscriptions/subscription.enum';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiTags, ApiOperation, ApiResponse, ApiExcludeController } from '@nestjs/swagger';


interface HealthStatus {
  status: 'ok' | 'degraded' | 'down';
  timestamp: string;
  uptime: number;
  checks: Record<string, CheckResult>;
}

interface CheckResult {
  status: 'ok' | 'down';
  responseTimeMs?: number;
  detail?: string;
}

@ApiExcludeController()
@SkipThrottle()
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,

    @InjectQueue(BILLING_JOBS.CHARGE_INVOICE)
    private readonly billingQueue: Queue,
  ) { }

  // ── GET /health/live ────────────────────────────────────────────────────

  /**
   * Liveness probe — is the process itself alive?
   *
   * WHY so simple?
   * If this endpoint responds at all, the process is alive.
   * Checking DB here would be wrong — a DB outage should NOT cause
   * k8s to restart every pod simultaneously (restart cascade).
   * DB outages are handled by the readiness probe instead.
   *
   * Returns 200 always (if the process can respond, it's alive).
   */
  @Get('live')
  @ApiOperation({
    summary: 'Liveness probe',
    description: 'Returns 200 if the process is alive. Used by k8s liveness probe. Never fails due to dependency issues.',
  })
  @ApiResponse({ status: 200, description: 'Process is alive' })
  @HttpCode(HttpStatus.OK)
  getLiveness(): { status: string; timestamp: string } {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }

  // ── GET /health/ready ───────────────────────────────────────────────────

  /**
   * Readiness probe — can this pod accept traffic?
   *
   * Checks all external dependencies. If any are down, returns 503.
   * k8s will stop routing traffic to this pod until it recovers.
   *
   * WHY return 503 instead of 200 with a degraded status?
   * k8s readiness probes check the HTTP status code, not the body.
   * 503 = remove from load balancer.
   * 200 = keep routing traffic.
   * The body with check details is for human debugging, not k8s.
   */
  @Get('ready')
  @ApiOperation({
    summary: 'Readiness probe',
    description: `
Returns 200 when the pod can accept traffic. Used by k8s readiness probe.

**Checks:**
- PostgreSQL connection (SELECT 1)
- Redis / BullMQ connection
- Pending migrations (fails if unapplied migrations exist)

Returns 503 if any check fails — k8s removes pod from load balancer until recovery.
    `,
  })
  @ApiResponse({ status: 200, description: 'All dependencies healthy' })
  @ApiResponse({ status: 503, description: 'One or more dependencies unhealthy' })
  async getReadiness(): Promise<HealthStatus> {
    const checks: Record<string, CheckResult> = {};
    let allHealthy = true;

    // ── Check 1: PostgreSQL ─────────────────────────────────────────────
    const dbStart = Date.now();
    try {
      /**
       * WHY SELECT 1 instead of a real query?
       * SELECT 1 is the lightest possible query — no table access,
       * no planning, just a round-trip to verify the connection is alive.
       * If this fails, the connection pool is broken or DB is unreachable.
       */
      await this.dataSource.query('SELECT 1');
      checks.database = {
        status: 'ok',
        responseTimeMs: Date.now() - dbStart,
      };
    } catch (error) {
      allHealthy = false;
      checks.database = {
        status: 'down',
        responseTimeMs: Date.now() - dbStart,
        detail: 'PostgreSQL connection failed',
      };
      this.logger.error(`Health check — DB down: ${error.message}`);
    }

    // ── Check 2: Redis / BullMQ ─────────────────────────────────────────
    const redisStart = Date.now();
    try {
      /**
       * WHY check queue.isPaused() instead of a raw Redis PING?
       * isPaused() goes through BullMQ's Redis client — the same one
       * your workers use. If this works, your workers can connect.
       * A raw Redis PING might succeed even if the BullMQ-specific
       * keyspace is corrupted or the connection pool is exhausted.
       */
      await this.billingQueue.isPaused();
      const queueDepth = await this.billingQueue.getWaitingCount();

      checks.redis = {
        status: 'ok',
        responseTimeMs: Date.now() - redisStart,
        detail: `Queue depth: ${queueDepth} waiting jobs`,
      };

      /**
       * WHY warn on high queue depth but not fail readiness?
       * A deep queue means workers are falling behind — a performance
       * issue, not an availability issue. The pod can still accept new
       * requests and process them. Failing readiness here would remove
       * the pod from the load balancer, making the backup WORSE.
       *
       * Alert on this metric instead (Prometheus/Datadog gauge on queue depth).
       */
      if (queueDepth > 1000) {
        this.logger.warn(`High queue depth detected: ${queueDepth} waiting jobs`);
      }
    } catch (error) {
      allHealthy = false;
      checks.redis = {
        status: 'down',
        responseTimeMs: Date.now() - redisStart,
        detail: 'Redis/BullMQ connection failed',
      };
      this.logger.error(`Health check — Redis down: ${error.message}`);
    }

    // ── Check 3: Pending Migrations ─────────────────────────────────────
    try {
      const pendingMigrations = await this.dataSource.showMigrations();

      if (pendingMigrations) {
        /**
         * WHY fail readiness if migrations are pending?
         * If you deploy a new version that requires a DB migration,
         * the old pods (running old code) should stay healthy and
         * serve traffic while the new pod runs migrations.
         *
         * Once migrations complete, migrationsRun:true in database.config.ts
         * means the new pod already applied them during startup.
         * The new pod then passes this check and becomes ready.
         *
         * This pattern enables zero-downtime deployments:
         *   Old pods → healthy, serving traffic
         *   New pod  → applies migrations → passes readiness → joins load balancer
         *   Old pods → k8s drains and replaces them
         */
        allHealthy = false;
        checks.migrations = {
          status: 'down',
          detail: 'Pending migrations detected — pod not ready',
        };
      } else {
        checks.migrations = { status: 'ok' };
      }
    } catch {
      // Migration check failure is not critical enough to fail readiness
      checks.migrations = { status: 'ok', detail: 'Migration check skipped' };
    }

    const response: HealthStatus = {
      status: allHealthy ? 'ok' : 'down',
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
      checks,
    };

    if (!allHealthy) {
      throw new ServiceUnavailableException(response);
    }

    return response;
  }
}