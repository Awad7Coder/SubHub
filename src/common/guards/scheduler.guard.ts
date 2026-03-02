/**
 * SCHEDULER BOOTSTRAP GUARD
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Add this to your main.ts bootstrap to prevent duplicate cron execution
 * when running multiple instances (Docker Swarm, Kubernetes, PM2 cluster).
 *
 * USAGE IN main.ts:
 *
 *   import { bootstrapApp } from './scheduler/scheduler.guard';
 *
 *   async function bootstrap() {
 *     const app = await NestFactory.create(AppModule);
 *
 *     if (process.env.SCHEDULER_ENABLED === 'true') {
 *       app.get(SchedulerModule); // activate crons on this instance only
 *       console.log('✅ Scheduler ENABLED on this instance');
 *     } else {
 *       console.log('⏭️  Scheduler DISABLED on this instance');
 *     }
 *
 *     await app.listen(3000);
 *   }
 *
 * KUBERNETES DEPLOYMENT PATTERN:
 *
 *   # api-deployment.yaml — 3 replicas, NO scheduler
 *   env:
 *     - name: SCHEDULER_ENABLED
 *       value: "false"
 *
 *   # scheduler-deployment.yaml — 1 replica, scheduler ON
 *   env:
 *     - name: SCHEDULER_ENABLED
 *       value: "true"
 *   replicas: 1   ← NEVER scale this above 1 without distributed locking
 *
 * DOCKER COMPOSE PATTERN:
 *
 *   services:
 *     api:
 *       environment:
 *         SCHEDULER_ENABLED: "false"
 *       deploy:
 *         replicas: 3
 *
 *     scheduler:
 *       environment:
 *         SCHEDULER_ENABLED: "true"
 *       deploy:
 *         replicas: 1
 *
 * ─────────────────────────────────────────────────────────────────────────
 * NEXT LEVEL: Redis Distributed Lock (when you need scheduler HA)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * If you need the scheduler to survive pod crashes (high availability),
 * implement distributed locking with redlock:
 *
 *   npm install redlock
 *
 *   // In each @Cron handler, before the business logic:
 *   const redlock = new Redlock([redisClient]);
 *   const lock = await redlock.acquire(['lock:renewal-check'], 55_000);
 *   try {
 *     await this.processRenewals();
 *   } finally {
 *     await lock.release();
 *   }
 *
 * With redlock: you CAN run replicas: 2 for the scheduler pod.
 * If pod 1 dies mid-run, pod 2 picks up the next cron tick.
 * The lock prevents both from running simultaneously.
 *
 * Without redlock: keep replicas: 1 and accept the ~30 second gap
 * between pod crash and Kubernetes restarting it.
 *
 * For most SaaS products at <$10M ARR: replicas:1 is completely fine.
 */

export const SCHEDULER_ENABLED = process.env.SCHEDULER_ENABLED === 'true';