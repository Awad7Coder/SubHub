import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe, Logger } from '@nestjs/common';
import { WinstonModule } from 'nest-winston';
import { winstonConfig } from './config/logger.config';
import { GlobalExceptionFilter } from './common/exceptions/global.exception.filter';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as express from 'express';   

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: WinstonModule.createLogger(winstonConfig),
    rawBody: true,  
  });

  const logger = new Logger('Bootstrap');

  app.enableShutdownHooks();
  app.setGlobalPrefix('api');

  /**
   * WHY BEFORE useGlobalFilters/useGlobalPipes?
   *
   * Express middleware runs in registration order.
   * This must intercept /api/webhooks/stripe BEFORE NestJS's JSON parser
   * converts req.body to an object — once parsed, raw bytes are gone forever.
   * stripe.webhooks.constructEvent() needs the original Buffer to verify
   * the HMAC-SHA256 signature.
   */
  app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' })); 

  app.useGlobalFilters(new GlobalExceptionFilter());

  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }));

  if (process.env.NODE_ENV !== 'production') {
    const config = new DocumentBuilder()
      .setTitle('SubHub Billing API')
      .setDescription(`
          ## SubHub — Subscription Billing Engine

          A production-grade billing microservice handling:
          - **Subscription lifecycle** — create, renew, cancel, reactivate
          - **Payment processing** — charge, retry, refund via Stripe
          - **Usage tracking** — per-subscription action metering with limits
          - **Invoice management** — open, paid, void, uncollectible states

          ### Authentication
          This service operates behind an API Gateway that handles JWT authentication.
          All requests reaching this service are pre-authenticated.
          Pass \`x-customer-id\` header to scope requests to a customer.

          ### Idempotency
          All state-mutating endpoints (POST, DELETE that trigger charges) require
          an \`Idempotency-Key\` header. Replaying the same key returns the cached
          response without re-executing the handler.

          ### Rate Limiting
          - Standard endpoints: 100/sec, 300/min, 1000/hr
          - Payment endpoints: 5/min
          - Health/metrics: unlimited
      `)
      .setVersion('1.0.0')
      .addTag('customers', 'Customer account management')
      .addTag('plans', 'Subscription plan catalog')
      .addTag('subscriptions', 'Subscription lifecycle')
      .addTag('invoices', 'Invoice retrieval')
      .addTag('payments', 'Payment history and retry')
      .addTag('usage', 'Usage logging and metering')
      .addTag('health', 'Health and readiness probes')
      .addApiKey(
        { type: 'apiKey', name: 'Idempotency-Key', in: 'header',
          description: 'Required on POST/DELETE endpoints that trigger charges' },
        'idempotency-key',
      )
      .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('docs', app, document, {
      customSiteTitle: 'SubHub API Docs',
      swaggerOptions: {
        persistAuthorization: true,
        docExpansion: 'list',
        filter: true,
        showRequestDuration: true,
      },
    });
    logger.log(`📚 Swagger docs available at: http://localhost:${process.env.PORT ?? 3000}/docs`);
  }

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  logger.log(`🚀 SubHub is running on: http://localhost:${port}/api`);
  logger.log(
    process.env.SCHEDULER_ENABLED === 'true'
      ? '✅ Scheduler ENABLED — cron jobs are active on this instance'
      : '⏭️  Scheduler DISABLED — this is an API-only instance',
  );
}

bootstrap();