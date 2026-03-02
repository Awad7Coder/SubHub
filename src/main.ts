import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe, Logger } from '@nestjs/common';
import { WinstonModule } from 'nest-winston';
import { winstonConfig } from './config/logger.config';
import { GlobalExceptionFilter } from './common/exceptions/global.exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: WinstonModule.createLogger(winstonConfig),
  });

  const logger = new Logger('Bootstrap');

  app.setGlobalPrefix('api');

  app.useGlobalFilters(new GlobalExceptionFilter());

  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }));

  const port = process.env.PORT ?? 3000;
  await app.listen(port);

  logger.log(`🚀 SubHub is running on: http://localhost:${port}/api`);

  /**
   * WHY log scheduler state here and not in AppModule?
   * AppModule is a class decorator — it has no logger and no lifecycle hook
   * that fires after the app is fully ready. main.ts runs after the entire
   * app boots, so this log appears at the right moment: when the app is
   * actually listening and crons (if enabled) are actually ticking.
   */
  logger.log(
    process.env.SCHEDULER_ENABLED === 'true'
      ? '✅ Scheduler ENABLED — cron jobs are active on this instance'
      : '⏭️  Scheduler DISABLED — this is an API-only instance',
  );
}

bootstrap();