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

const ENV = process.env.NODE_ENV;
const SCHEDULER_ENABLED = process.env.SCHEDULER_ENABLED === 'true';

@Module({
  imports: [CustomersModule, SubscriptionModule, PaymentsModule, UsageModule, BillingModule, NotificationModule, MonitoringModule,

    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: !ENV ? ".env" : `.env.${ENV.trim()}`,
      load: [databaseConfig],
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

    ...(SCHEDULER_ENABLED ? [SchedulerModule] : []),
  ],
  controllers: [],
  providers: [],
})
export class AppModule { }
