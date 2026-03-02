import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Subscription } from '../subscriptions/entity/subscription.entity';
import { Customer } from '../customers/entity/customer.entity';
import { Plan } from '../billing/entity/plan.entity';
import { Invoice } from '../invoice/entity/invoice.entity';
import { InvoiceStatus } from '../invoice/invoice.enum';
import { InvoiceService } from '../invoice/invoice.service';
import { BillingService } from '../billing/billing.service';
import { NotificationService } from '../notifications/notifications.service';
import {
    CustomerNotFoundException,
    InactiveCustomerException,
    PlanNotFoundException,
    InactivePlanException,
    SubscriptionNotFoundException,
    DuplicateSubscriptionException,
} from '../../common/exceptions/domain.exception';
import {
    SubscriptionStatus,
    VALID_SUBSCRIPTION_TRANSITIONS,
} from './subscription.enum';

// ─── DTOs ──────────────────────────────────────────────────────────────────

export interface CreateSubscriptionDto {
    customerId: string;
    planId: string;
    metadata?: Record<string, any>;
}

export interface SubscriptionResult {
    subscription: Subscription;
    invoiceId: string;
}

// ─── Custom Exception ──────────────────────────────────────────────────────

export class InvalidSubscriptionStateException extends Error {
    constructor(subscriptionId: string, current: string, attempted: string) {
        super(
            `Cannot perform '${attempted}' on subscription ${subscriptionId} — current state is '${current}'`,
        );
        this.name = 'InvalidSubscriptionStateException';
    }
}

// ─── Service ───────────────────────────────────────────────────────────────

@Injectable()
export class SubscriptionService {
    private readonly logger = new Logger(SubscriptionService.name);

    constructor(
        // ✅ FIX 4: Repository generic now uses the correct entity type
        @InjectRepository(Subscription)
        private readonly subscriptionRepo: Repository<Subscription>,

        @InjectRepository(Customer)
        private readonly customerRepo: Repository<Customer>,

        @InjectRepository(Plan)
        private readonly planRepo: Repository<Plan>,

        private readonly invoiceService: InvoiceService,
        private readonly billingService: BillingService,
        private readonly notificationService: NotificationService,
        private readonly dataSource: DataSource,
    ) { }

    // ─── Subscribe ────────────────────────────────────────────────────────────

    async subscribe(dto: CreateSubscriptionDto): Promise<SubscriptionResult> {
        this.logger.log(
            `Subscribe request: customer ${dto.customerId} → plan ${dto.planId}`,
        );

        // ── GUARDS ────────────────────────────────────────────────────────────
        const customer = await this.customerRepo.findOne({
            where: { id: dto.customerId },
        });

        if (!customer) throw new CustomerNotFoundException(dto.customerId);
        if (!customer.is_active) throw new InactiveCustomerException(dto.customerId);

        const plan = await this.planRepo.findOne({ where: { id: dto.planId } });

        if (!plan) throw new PlanNotFoundException(dto.planId);
        if (!plan.is_active) throw new InactivePlanException(dto.planId);

        const existingActive = await this.subscriptionRepo.findOne({
            where: {
                customer_id: dto.customerId,
                status: SubscriptionStatus.ACTIVE,
            },
        });

        if (existingActive) {
            throw new DuplicateSubscriptionException(dto.customerId);
        }

        let subscription: Subscription = null!;
        let invoiceId: string = null!;

        await this.dataSource.transaction(async (manager) => {
            const periodResult = await manager.query<[{ period_end: Date }]>(
                `SELECT NOW() + $1::interval AS period_end`,
                [plan.interval],
            );
            const periodEnd = periodResult[0].period_end;

            // ✅ FIX 6: manager.create() uses Subscription, not Subscription from rxjs
            const newSubscription = manager.create(Subscription, {
                customer_id: dto.customerId,
                plan_id: dto.planId,
                status: SubscriptionStatus.PENDING,
                current_period_start: new Date(),
                current_period_end: periodEnd,
                cancel_at_period_end: false,
                metadata: dto.metadata,
            });

            subscription = await manager.save(Subscription, newSubscription);

            // ✅ FIX 7: Invoice and InvoiceStatus are now static imports at the top.
            // No more dynamic import() inside the transaction callback.
            // This is simpler, faster, and reliable.
            const invoice = manager.create(Invoice, {
                subscription_id: subscription.id,
                customer_id: dto.customerId,
                amount: plan.price,
                currency: plan.currency,
                status: InvoiceStatus.OPEN,
            });

            const savedInvoice = await manager.save(Invoice, invoice);
            invoiceId = savedInvoice.id;
        });

        // Queue charge AFTER transaction commits — never inside
        await this.billingService.queueCharge(invoiceId);

        this.logger.log(
            `Subscription ${subscription.id} created (PENDING) — charge queued for invoice ${invoiceId}`,
        );

        return { subscription, invoiceId };
    }

    // ─── Cancel (Soft) ────────────────────────────────────────────────────────

    async cancel(subscriptionId: string): Promise<Subscription> {
        const subscription = await this.findOneOrFail(subscriptionId);

        if (
            subscription.status !== SubscriptionStatus.ACTIVE &&
            subscription.status !== SubscriptionStatus.PAST_DUE
        ) {
            throw new InvalidSubscriptionStateException(
                subscriptionId,
                subscription.status,
                'cancel',
            );
        }

        if (subscription.cancel_at_period_end) {
            this.logger.warn(
                `Subscription ${subscriptionId} is already set to cancel at period end`,
            );
            return subscription;
        }

        subscription.cancel_at_period_end = true;
        const updated = await this.subscriptionRepo.save(subscription);

        const customer = await this.customerRepo.findOne({
            where: { id: subscription.customer_id },
        });

        const plan = await this.planRepo.findOne({
            where: { id: subscription.plan_id },
        });

        await this.notificationService.sendSubscriptionCancelled({
            customerEmail: customer?.email ?? '',
            customerName: customer?.full_name,
            planName: plan?.name ?? 'Unknown Plan',
            cancelledAt: new Date(),
            accessUntil: subscription.current_period_end,
            cancelledImmediately: false,
        });

        this.logger.log(
            `Subscription ${subscriptionId} set to cancel at ${subscription.current_period_end.toISOString()}`,
        );

        return updated;
    }

    // ─── Cancel Immediately ───────────────────────────────────────────────────

    async cancelImmediately(subscriptionId: string): Promise<Subscription> {
        const subscription = await this.findOneOrFail(subscriptionId);

        this.validateTransition(subscription, SubscriptionStatus.CANCELLED);

        subscription.status = SubscriptionStatus.CANCELLED;
        subscription.cancel_at_period_end = false;
        const updated = await this.subscriptionRepo.save(subscription);

        const customer = await this.customerRepo.findOne({
            where: { id: subscription.customer_id },
        });
        const plan = await this.planRepo.findOne({
            where: { id: subscription.plan_id },
        });

        await this.notificationService.sendSubscriptionCancelled({
            customerEmail: customer?.email ?? '',
            customerName: customer?.full_name,
            planName: plan?.name ?? 'Unknown Plan',
            cancelledAt: new Date(),
            accessUntil: new Date(),
            cancelledImmediately: true,
        });

        this.logger.log(`Subscription ${subscriptionId} cancelled immediately`);
        return updated;
    }

    // ─── Move to Past Due ─────────────────────────────────────────────────────

    async moveToPastDue(subscriptionId: string): Promise<Subscription> {
        const subscription = await this.findOneOrFail(subscriptionId);

        this.validateTransition(subscription, SubscriptionStatus.PAST_DUE);

        subscription.status = SubscriptionStatus.PAST_DUE;
        const updated = await this.subscriptionRepo.save(subscription);

        this.logger.warn(
            `Subscription ${subscriptionId} moved to PAST_DUE — payment exhausted`,
        );

        return updated;
    }

    // ─── Activate After Payment ───────────────────────────────────────────────

    async activateAfterPayment(subscriptionId: string): Promise<Subscription> {
        const subscription = await this.findOneOrFail(subscriptionId);

        this.validateTransition(subscription, SubscriptionStatus.ACTIVE);

        subscription.status = SubscriptionStatus.ACTIVE;
        const updated = await this.subscriptionRepo.save(subscription);

        this.logger.log(
            `Subscription ${subscriptionId} activated after successful payment`,
        );
        return updated;
    }

    // ─── Renew ────────────────────────────────────────────────────────────────

    async renew(subscriptionId: string): Promise<void> {
        const subscription = await this.findOneOrFail(subscriptionId);

        if (subscription.status !== SubscriptionStatus.ACTIVE) {
            this.logger.warn(
                `Renewal skipped for subscription ${subscriptionId} — status is ${subscription.status}`,
            );
            return;
        }

        if (subscription.cancel_at_period_end) {
            this.logger.log(
                `Subscription ${subscriptionId} reached period end with cancel flag — cancelling`,
            );
            await this.cancelImmediately(subscriptionId);
            return;
        }

        const plan = await this.planRepo.findOne({
            where: { id: subscription.plan_id },
        });

        let invoiceId: string = null!;

        await this.dataSource.transaction(async (manager) => {
            const periodResult = await manager.query<[{ period_end: Date }]>(
                `SELECT $1::timestamptz + $2::interval AS period_end`,
                [subscription.current_period_end, plan!.interval],
            );
            const newPeriodEnd = periodResult[0].period_end;

            // ✅ FIX 9: manager.update uses Subscription, not the rxjs type
            await manager.update(Subscription, subscriptionId, {
                current_period_start: subscription.current_period_end,
                current_period_end: newPeriodEnd,
            });

            // ✅ Static imports used here — clean and simple
            const invoice = manager.create(Invoice, {
                subscription_id: subscriptionId,
                customer_id: subscription.customer_id,
                amount: plan!.price,
                currency: plan!.currency,
                status: InvoiceStatus.OPEN,
                metadata: { renewal: true },
            });

            const savedInvoice = await manager.save(Invoice, invoice);
            invoiceId = savedInvoice.id;
        });

        await this.billingService.queueCharge(invoiceId);

        const customer = await this.customerRepo.findOne({
            where: { id: subscription.customer_id },
        });

        const refreshed = await this.subscriptionRepo.findOne({
            where: { id: subscriptionId },
        });

        await this.notificationService.sendSubscriptionRenewed({
            customerEmail: customer?.email ?? '',
            customerName: customer?.full_name,
            planName: plan!.name,
            amount: plan!.price,
            currency: plan!.currency,
            nextPeriodEnd: refreshed!.current_period_end,
        });

        this.logger.log(
            `Subscription ${subscriptionId} renewed — charge queued for invoice ${invoiceId}`,
        );
    }

    // ─── Query Methods ────────────────────────────────────────────────────────

    async getActiveSubscription(customerId: string): Promise<Subscription | null> {
        return this.subscriptionRepo.findOne({
            where: {
                customer_id: customerId,
                status: SubscriptionStatus.ACTIVE,
            },
            relations: ['plan'],
        });
    }

    async findById(subscriptionId: string): Promise<Subscription | null> {
        return this.subscriptionRepo.findOne({
            where: { id: subscriptionId },
            relations: ['plan', 'customer'],
        });
    }

    // ─── Private Helpers ──────────────────────────────────────────────────────

    private async findOneOrFail(subscriptionId: string): Promise<Subscription> {
        const subscription = await this.subscriptionRepo.findOne({
            where: { id: subscriptionId },
        });

        if (!subscription) {
            throw new SubscriptionNotFoundException(subscriptionId);
        }

        return subscription;
    }

    private validateTransition(
        subscription: Subscription,
        targetStatus: SubscriptionStatus,
    ): void {
        const currentStatus = subscription.status as SubscriptionStatus;
        const allowed = VALID_SUBSCRIPTION_TRANSITIONS[currentStatus];

        if (!allowed.includes(targetStatus)) {
            throw new InvalidSubscriptionStateException(
                subscription.id,
                currentStatus,
                `transition to ${targetStatus}`,
            );
        }
    }
}