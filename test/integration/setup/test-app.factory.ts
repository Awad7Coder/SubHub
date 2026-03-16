import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), '.env.test') });

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { DataSource } from 'typeorm';

// ── Entities — explicit list, no glob ────────────────────────────────────
import { Customer } from '../../../src/modules/customers/entity/customer.entity';
import { Plan } from '../../../src/modules/plan/entity/plan.entity';
import { Subscription } from '../../../src/modules/subscriptions/entity/subscription.entity';
import { Invoice } from '../../../src/modules/invoice/entity/invoice.entity';
import { Payment } from '../../../src/modules/payments/entity/payment.entity';
import { UsageLog } from '../../../src/modules/usage/entity/usage-log.entity';
// ⚠️  CHECK: open your idempotency.entity.ts and confirm the exported class name
// It might be: Idempotency, IdempotencyKey, IdempotencyKeyEntity
// Replace the import below to match exactly what your file exports
import { Idempotency } from '../../../src/modules/idempotency/entity/idempotency.entity';

// ── Providers ─────────────────────────────────────────────────────────────
import { MockPaymentProvider } from '../../../src/modules/billing/provider/mock.provider';
import { PAYMENT_PROVIDER } from '../../../src/modules/payments/providers/payment.provider.interface';
import { GlobalExceptionFilter } from '../../../src/common/exceptions/global.exception.filter';

// ── Modules ───────────────────────────────────────────────────────────────
import { CustomersModule } from '../../../src/modules/customers/customers.module';
import { PlansModule } from '../../../src/modules/plan/plan.module';
import { SubscriptionModule } from '../../../src/modules/subscriptions/subscriptions.module';
import { BillingModule } from '../../../src/modules/billing/billing.module';
import { InvoiceModule } from '../../../src/modules/invoice/invoice.module';
import { UsageModule } from '../../../src/modules/usage/usage.module';
import { NotificationModule } from '../../../src/modules/notifications/notifications.module';
import { IdempotencyModule } from '../../../src/modules/idempotency/idempotency.module';
import { BILLING_JOBS } from '../../../src/modules/subscriptions/subscription.enum';

export interface TestApp {
  app: INestApplication;
  module: TestingModule;
  mockProvider: MockPaymentProvider;
}

export async function createTestApp(): Promise<TestApp> {
  const mockProvider = new MockPaymentProvider();

  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        envFilePath: '.env.test',
      }),

      TypeOrmModule.forRoot({
        type: 'postgres',
        host: process.env.DB_HOST ?? 'localhost',
        port: parseInt(process.env.DB_PORT ?? '5432', 10),
        username: process.env.DB_USERNAME ?? 'postgres',
        password: process.env.DB_PASSWORD ?? 'awadadmin16',
        database: process.env.DB_NAME ?? 'subhub_test',
        entities: [
          Customer,
          Plan,
          Subscription,
          Invoice,
          Payment,
          UsageLog,
          Idempotency,   // ← the ENTITY class, NOT a guard
        ],
        synchronize: true,
        logging: false,
      }),

      BullModule.forRoot({
        connection: {
          host: process.env.REDIS_HOST ?? 'localhost',
          port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
          db: 1,
        },
      }),

      CustomersModule,
      PlansModule,
      SubscriptionModule,
      BillingModule,
      InvoiceModule,
      UsageModule,
      NotificationModule,
      IdempotencyModule,
    ],
  })
    .overrideProvider(PAYMENT_PROVIDER)
    .useValue(mockProvider)
    .compile();

  const app = module.createNestApplication();
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  }));

  await app.init();
  return { app, module, mockProvider };
}

export async function clearDatabase(app: INestApplication): Promise<void> {
  const dataSource = app.get(DataSource);
  const billingQueue = app.get(getQueueToken(BILLING_JOBS.CHARGE_INVOICE));

  // 1. Pause the queue so no NEW workers can start
  await billingQueue.pause();

  // 2. Wipe Redis completely for this queue
  // This kills any 'waiting' or 'delayed' jobs
  await billingQueue.drain();
  await billingQueue.obliterate({ force: true });

  // 3. Clear Postgres
  // CASCADE ensures that if we delete an invoice, the related payments die too
  await dataSource.query(`TRUNCATE TABLE idempotency_keys, usage_logs, payments, invoices, subscriptions, customers, plans RESTART IDENTITY CASCADE`);
  
  // 4. Leave it paused or resume it
  // Since you call attemptCharge manually in tests, leaving it paused is safer
}