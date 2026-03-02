import { Module } from '@nestjs/common';
import { NotificationService } from './notifications.service';

/**
 * WHY no TypeOrmModule.forFeature() here?
 *
 * NotificationService touches zero database tables.
 * It's a pure output service — it takes data and sends it somewhere.
 * No entity registrations needed.
 *
 * This is a good sign you've designed the service correctly.
 * If NotificationService needed DB access, that would be a smell
 * suggesting it's doing too much.
 */
@Module({
  providers: [NotificationService],
  exports: [NotificationService],
})
export class NotificationModule {}