import {
  Injectable,
  Logger,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Customer } from './entity/customer.entity';
import { CreateCustomerDto, UpdateCustomerDto } from './dto/customer.dto';

@Injectable()
export class CustomersService {
  private readonly logger = new Logger(CustomersService.name);

  constructor(
    @InjectRepository(Customer)
    private readonly customerRepo: Repository<Customer>,
  ) {}

  // ── Create ────────────────────────────────────────────────────────────────

  async create(dto: CreateCustomerDto): Promise<Customer> {
    // Check for duplicate email before hitting the DB unique constraint
    // WHY: A constraint violation gives a cryptic DB error.
    // An explicit check gives a clean 409 with a readable message.
    const existing = await this.customerRepo.findOne({
      where: { email: dto.email },
    });

    if (existing) {
      throw new ConflictException(
        `Customer with email '${dto.email}' already exists`,
      );
    }

    const customer = this.customerRepo.create({
      email: dto.email,
      full_name: dto.full_name,
      payment_provider: dto.payment_provider ?? 'stripe',
      metadata: dto.metadata,
      is_active: true,
    });

    const saved = await this.customerRepo.save(customer);
    this.logger.log(`Customer created: ${saved.id} (${saved.email})`);
    return saved;
  }

  // ── Find All ──────────────────────────────────────────────────────────────

  async findAll(options?: {
    activeOnly?: boolean;
    page?: number;
    limit?: number;
  }): Promise<{ data: Customer[]; total: number; page: number; limit: number }> {
    const page = options?.page ?? 1;
    const limit = Math.min(options?.limit ?? 20, 100);
    const skip = (page - 1) * limit;

    const qb = this.customerRepo.createQueryBuilder('customer');

    if (options?.activeOnly) {
      qb.where('customer.is_active = true');
    }

    const [data, total] = await qb
      .orderBy('customer.created_at', 'DESC')
      .skip(skip)
      .take(limit)
      .getManyAndCount();

    return { data, total, page, limit };
  }

  // ── Find One ──────────────────────────────────────────────────────────────

  async findById(id: string): Promise<Customer> {
    const customer = await this.customerRepo.findOne({ where: { id } });

    if (!customer) {
      throw new NotFoundException(`Customer '${id}' not found`);
    }

    return customer;
  }

  async findByEmail(email: string): Promise<Customer> {
    const customer = await this.customerRepo.findOne({ where: { email } });

    if (!customer) {
      throw new NotFoundException(`Customer with email '${email}' not found`);
    }

    return customer;
  }

  // ── Update ────────────────────────────────────────────────────────────────

  async update(id: string, dto: UpdateCustomerDto): Promise<Customer> {
    const customer = await this.findById(id);

    Object.assign(customer, dto);
    const updated = await this.customerRepo.save(customer);

    this.logger.log(`Customer updated: ${id}`);
    return updated;
  }

  // ── Deactivate ────────────────────────────────────────────────────────────

  /**
   * WHY deactivate instead of delete?
   * Customers have invoices, payments, subscriptions — all referencing them.
   * Hard delete would cascade or fail on FK constraints.
   * Soft deactivation preserves the financial history (legal requirement)
   * while preventing new subscriptions from being created for this customer.
   *
   * The InactiveCustomerException in SubscriptionService.subscribe()
   * enforces this — deactivated customers cannot start new subscriptions.
   */
  async deactivate(id: string): Promise<Customer> {
    const customer = await this.findById(id);

    if (!customer.is_active) {
      throw new BadRequestException(`Customer '${id}' is already inactive`);
    }

    customer.is_active = false;
    const updated = await this.customerRepo.save(customer);

    this.logger.log(`Customer deactivated: ${id}`);
    return updated;
  }

  async reactivate(id: string): Promise<Customer> {
    const customer = await this.findById(id);

    if (customer.is_active) {
      throw new BadRequestException(`Customer '${id}' is already active`);
    }

    customer.is_active = true;
    const updated = await this.customerRepo.save(customer);

    this.logger.log(`Customer reactivated: ${id}`);
    return updated;
  }
}