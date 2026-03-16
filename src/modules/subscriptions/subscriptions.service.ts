import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Subscription } from '../subscriptions/entity/subscription.entity';
import { Customer } from '../customers/entity/customer.entity';
import { Plan } from '../plan/entity/plan.entity';
import { Invoice } from '../invoice/entity/invoice.entity';
import { InvoiceStatus } from '../invoice/invoice.enum';
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
import { CreateSubscriptionDto } from './dto/subscriptions.dto';

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
        @InjectRepository(Subscription)
        private readonly subscriptionRepo: Repository<Subscription>,

        @InjectRepository(Customer)
        private readonly customerRepo: Repository<Customer>,

        @InjectRepository(Plan)
        private readonly planRepo: Repository<Plan>,

        @Inject(forwardRef(() => BillingService)) 
        private readonly billingService: BillingService,

        private readonly notificationService: NotificationService,
        private readonly dataSource: DataSource,
    ) { }

    async subscribe(dto: CreateSubscriptionDto): Promise<SubscriptionResult> {
        this.logger.log(
            `Subscribe request: customer ${dto.customerId} → plan ${dto.planId}`,
        );

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

        await this.billingService.queueCharge(invoiceId);

        this.logger.log(
            `Subscription ${subscription.id} created (PENDING) — charge queued for invoice ${invoiceId}`,
        );

        return { subscription, invoiceId };
    }

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

            await manager.update(Subscription, subscriptionId, {
                current_period_start: subscription.current_period_end,
                current_period_end: newPeriodEnd,
            });

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

    /**
 * Called by WebhooksService when a payment_intent.succeeded webhook
 * arrives for a subscription that's still PENDING in our DB.
 * This is the reconciliation path — our DB write failed after Stripe charged.
 */
    async activate(subscriptionId: string): Promise<Subscription> {
        const subscription = await this.findOneOrFail(subscriptionId);

        if (subscription.status === SubscriptionStatus.ACTIVE) {
            return subscription; // idempotent
        }

        // Note: activated_at may not exist on your entity yet — see below
        subscription.status = SubscriptionStatus.ACTIVE;
        return this.subscriptionRepo.save(subscription);  
    }
}