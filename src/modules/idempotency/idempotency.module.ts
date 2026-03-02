import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RequiresIdempotencyGuard, RequiresIdempotencyKey } from 'src/common/guards/Idempotency.guard';
import { IdempotencyService } from './idempotency.server';
import { IdempotencyInterceptor } from 'src/common/interceptors/Idempotency.interceptor';
import { Idempotency } from './entity/idempotency.entity';


/**
 * WHY export all three providers?
 *
 * IdempotencyService      → SchedulerModule needs it for the cleanup job
 * IdempotencyInterceptor  → Controllers apply it with @UseInterceptors()
 * RequiresIdempotencyGuard → Controllers apply it with @UseGuards()
 *
 * Any module that imports IdempotencyModule gets all three.
 * One import, complete protection.
 */
@Module({
  imports: [TypeOrmModule.forFeature([RequiresIdempotencyKey,Idempotency]),],
  providers: [IdempotencyService, IdempotencyInterceptor, RequiresIdempotencyGuard],
  exports: [IdempotencyService, IdempotencyInterceptor, RequiresIdempotencyGuard],
})
export class IdempotencyModule {}