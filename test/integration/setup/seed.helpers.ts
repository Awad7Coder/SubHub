import { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Customer } from '../../../src/modules/customers/entity/customer.entity';
import { Plan } from '../../../src/modules/plan/entity/plan.entity';

export interface SeedData {
  customer: Customer;
  activePlan: Plan;
  inactivePlan: Plan;
}

export async function seedBaseData(app: INestApplication): Promise<SeedData> {
  const customerRepo = app.get<Repository<Customer>>(getRepositoryToken(Customer));
  const planRepo = app.get<Repository<Plan>>(getRepositoryToken(Plan));

  const customer = await customerRepo.save(
    customerRepo.create({
      email: 'test@example.com',
      full_name: 'Test Customer',
      is_active: true,
      payment_provider: 'stripe',
    }),
  );

  const activePlan = await planRepo.save(
    planRepo.create({
      name: 'Pro Plan',
      price: 99.00,
      currency: 'usd',
      interval: '1 month',
      usage_limit: 1000,
      is_active: true,
    }),
  );

  const inactivePlan = await planRepo.save(
    planRepo.create({
      name: 'Deprecated Plan',
      price: 49.00,
      currency: 'usd',
      interval: '1 month',
      usage_limit: 500,
      is_active: false,
    }),
  );

  // Map 'plan' to 'activePlan' here so the return object matches the SeedData interface
  return { 
    customer, 
    activePlan, 
    inactivePlan, 
  };
}