import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Subscription } from 'rxjs';
import { Invoice } from './entity/invoice.entity';
import { InvoiceService } from './invoice.service';



/**
 * WHY import Subscription here?
 *
 * InvoiceService injects SubscriptionRepository to fetch subscription
 * data when generating invoices. TypeORM requires the entity to be
 * registered in the module that uses its repository.
 *
 * WHY export InvoiceService?
 * BillingService (Layer 2) needs to call InvoiceService.markAsPaid().
 * Exporting makes it available to any module that imports InvoiceModule.
 * This is NestJS's dependency injection at the module boundary level.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Invoice, Subscription])],
  providers: [InvoiceService],
  exports: [InvoiceService],
})
export class InvoiceModule {}