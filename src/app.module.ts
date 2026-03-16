import { Module } from '@nestjs/common';
import { CustomersModule } from './modules/customers/customers.module';
import { MonitoringModule } from './modules/monitoring/monitoring.module';
import { BillingModule } from './modules/billing/billing.module';
import { UsageModule } from './modules/usage/usage.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { ConfigModule, ConfigService } from '@nestjs/config';
import databaseConfig from './config/database.config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { envValidationSchema } from './config/env.validation';
import { BullModule } from '@nestjs/bullmq';
import { SchedulerModule } from './modules/Scheduler/scheduler.module';
import { NotificationModule } from './modules/notifications/notifications.module';
import { SubscriptionModule } from './modules/subscriptions/subscriptions.module';
import { IdempotencyModule } from './modules/idempotency/idempotency.module';
import { PlansModule } from './modules/plan/plan.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { ProcessedWebhookEvent } from './modules/webhooks/entity/webhookevent.entity';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import throttlerConfig from './config/throttler.config';

const ENV = process.env.NODE_ENV;
const SCHEDULER_ENABLED = process.env.SCHEDULER_ENABLED === 'true';

@Module({
  imports: [CustomersModule, SubscriptionModule, PaymentsModule, UsageModule, BillingModule, NotificationModule, MonitoringModule, IdempotencyModule, PlansModule, WebhooksModule, ProcessedWebhookEvent,

    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: !ENV ? ".env" : `.env.${ENV.trim()}`,
      load: [databaseConfig,throttlerConfig],
      validationSchema: envValidationSchema,
      validationOptions: {
        allowUnknown: true,
        abortEarly: true,
      },
    }),

    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const dbConfig = configService.get('database');
        return dbConfig;
      },
    }),

    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get('REDIS_HOST') || 'localhost',
          port: config.get('REDIS_PORT') || 6379,
        },
      }),
    }),

    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const throttle = config.get('throttle');
        if (!throttle) {
          throw new Error(
            'FATAL: [ThrottlerModule] "throttle" configuration namespace is missing. ' +
            'Did you add throttlerConfig to the ConfigModule.forRoot load array?'
          );
        }
        return [throttle.short, throttle.medium, throttle.long];
      },
    }),

    // ── Scheduler (conditional) ────────────────────────────────────────────
    //
    // WHY the spread pattern instead of a ternary on a single value?
    //
    //   WRONG:  imports: [SCHEDULER_ENABLED ? SchedulerModule : null]
    //   NestJS iterates the imports array and crashes on null/undefined.
    //
    //   CORRECT: ...( condition ? [Module] : [] )
    //   Spread of an empty array adds nothing. Spread of [Module] adds it.
    //   This is the idiomatic NestJS pattern for conditional module loading.
    //
    // Effect:
    //   SCHEDULER_ENABLED=true  → SchedulerModule loads, crons register
    //   SCHEDULER_ENABLED=false → SchedulerModule never loads, zero overhead
    //   (not set)               → treated as false — safe default
    //

    ...(SCHEDULER_ENABLED ? [SchedulerModule] : []),
  ],
  controllers: [],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard },],
})
export class AppModule { }
