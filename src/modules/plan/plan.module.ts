import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Plan } from './entity/plan.entity';
import { PlansController } from './plan.controller';
import { PlansService } from './plan.service';


@Module({
  imports: [TypeOrmModule.forFeature([Plan])],
  controllers: [PlansController],
  providers: [PlansService],
  exports: [PlansService],  // ← exported so BillingModule + SubscriptionsModule can use it
})
export class PlansModule {}