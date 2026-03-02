import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { IdempotencyModule } from '../idempotency/idempotency.module';
import { BillingModule } from '../billing/billing.module';
import { InvoiceModule } from '../invoice/invoice.module';
import { Payment } from './entity/payment.entity';
import { TypeOrmModule } from '@nestjs/typeorm';

@Module({
  imports: [
    // 1. Give the module access to the 'Payment' table in the database
    TypeOrmModule.forFeature([Payment]), 
    
    // 2. Import the "Offices" that provide the other services
    IdempotencyModule,
    BillingModule, 
    InvoiceModule,
  ],
  controllers: [PaymentsController],
  providers: [PaymentsService],
})
export class PaymentsModule {}