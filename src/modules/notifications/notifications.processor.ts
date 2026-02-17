import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';

@Processor('notification-queue')
export class NotificationsProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationsProcessor.name);

  async process(job: Job<any, any, string>): Promise<any> {
    this.logger.log(`Processing job ${job.id} of type ${job.name}...`);
    
    switch (job.name) {
      case 'welcome-email':
        // logic to send email
        return { sent: true };
      case 'payment-failed':
        // logic to send alert
        return { alerted: true };
      default:
        return {};
    }
  }
}