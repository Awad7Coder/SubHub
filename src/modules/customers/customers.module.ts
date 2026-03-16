import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Customer } from './entity/customer.entity';
import { CustomersService } from './customers.service';
import { CustomersController } from './customers.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Customer])],
  controllers: [CustomersController],
  providers: [CustomersService],
  /**
   * WHY export CustomersService?
   * SubscriptionService needs to verify a customer exists and is active
   * before creating a subscription. Exporting lets SubscriptionsModule
   * import CustomersModule and inject CustomersService.
   */
  exports: [CustomersService],
})
export class CustomersModule {}