import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Plan } from './entity/plan.entity';
import { CreatePlanDto, UpdatePlanDto } from './dto/plan.dto';


@Injectable()
export class PlansService {
  private readonly logger = new Logger(PlansService.name);

  constructor(
    @InjectRepository(Plan)
    private readonly planRepo: Repository<Plan>,
  ) {}

  // ── Create ────────────────────────────────────────────────────────────────

  async create(dto: CreatePlanDto): Promise<Plan> {
    const plan = this.planRepo.create({
      name: dto.name,
      price: dto.price,
      currency: dto.currency ?? 'usd',
      interval: dto.interval,
      usage_limit: dto.usage_limit ?? 0,
      is_active: true,
      metadata: dto.metadata,
    });

    const saved = await this.planRepo.save(plan);
    this.logger.log(`Plan created: ${saved.id} (${saved.name})`);
    return saved;
  }

  // ── Find All ──────────────────────────────────────────────────────────────

  async findAll(options?: {
    activeOnly?: boolean;
  }): Promise<Plan[]> {
    const qb = this.planRepo.createQueryBuilder('plan');

    if (options?.activeOnly) {
      qb.where('plan.is_active = true');
    }

    return qb.orderBy('plan.price', 'ASC').getMany();
  }

  // ── Find One ──────────────────────────────────────────────────────────────

  async findById(id: string): Promise<Plan> {
    const plan = await this.planRepo.findOne({ where: { id } });

    if (!plan) {
      throw new NotFoundException(`Plan '${id}' not found`);
    }

    return plan;
  }

  // ── Update ────────────────────────────────────────────────────────────────

  /**
   * WHY allow updating price on an existing plan?
   * Price changes only affect NEW subscriptions created after the change.
   * Existing active subscriptions keep their original price until they renew
   * — the invoice amount is based on the plan price AT TIME OF RENEWAL,
   * which reads the current plan.price.
   *
   * In a more sophisticated system you'd snapshot the plan price on each
   * subscription or invoice. For SubHub, plan.price is the live price
   * and existing subscribers see it on renewal.
   * Inform customers before changing prices.
   */
  async update(id: string, dto: UpdatePlanDto): Promise<Plan> {
    const plan = await this.findById(id);

    Object.assign(plan, dto);
    const updated = await this.planRepo.save(plan);

    this.logger.log(`Plan updated: ${id}`);
    return updated;
  }

  // ── Deactivate / Reactivate ───────────────────────────────────────────────

  /**
   * WHY deactivate instead of delete?
   * Active subscriptions reference plan_id. Deleting a plan that has
   * active subscribers would orphan those subscriptions or cascade-delete
   * subscription records — both are catastrophic.
   *
   * Deactivating prevents new subscriptions on this plan while
   * letting existing ones continue until cancelled naturally.
   */
  async deactivate(id: string): Promise<Plan> {
    const plan = await this.findById(id);

    if (!plan.is_active) {
      throw new BadRequestException(`Plan '${id}' is already inactive`);
    }

    plan.is_active = false;
    const updated = await this.planRepo.save(plan);

    this.logger.log(`Plan deactivated: ${id} — no new subscriptions allowed`);
    return updated;
  }

  async reactivate(id: string): Promise<Plan> {
    const plan = await this.findById(id);

    if (plan.is_active) {
      throw new BadRequestException(`Plan '${id}' is already active`);
    }

    plan.is_active = true;
    const updated = await this.planRepo.save(plan);

    this.logger.log(`Plan reactivated: ${id}`);
    return updated;
  }
}