import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  InvoiceNotFoundException,
  InvalidInvoiceStateException,
} from '../../common/exceptions/domain.exception';
import { InvoiceStatus, VALID_INVOICE_TRANSITIONS } from './invoice.enum';
import { Invoice } from './entity/invoice.entity';
import { Subscription } from '../subscriptions/entity/subscription.entity';

// ─── DTOs ──────────────────────────────────────────────────────────────────

/**
 * WHY a DTO for invoice generation instead of raw parameters?
 *
 * When you have 4+ parameters, positional arguments become a bug magnet.
 * compare:
 *   generateInvoice(subId, custId, amount, currency)  ← easy to swap args
 *   generateInvoice({ subscriptionId, customerId, amount, currency })  ← safe
 *
 * DTOs also make it trivial to add optional fields later (discount, tax)
 * without changing the method signature everywhere it's called.
 */
export interface GenerateInvoiceDto {
  subscriptionId: string;
  customerId: string;
  amount: number;
  currency?: string;         // defaults to 'USD' if omitted
  metadata?: Record<string, any>;
}

// ─── Return Types ──────────────────────────────────────────────────────────

export interface InvoiceSummary {
  id: string;
  customerId: string;
  subscriptionId: string | null;
  amount: number;
  currency: string;
  status: InvoiceStatus;
  createdAt: Date;
}

// ─── Service ───────────────────────────────────────────────────────────────

@Injectable()
export class InvoiceService {
  /**
   * WHY a logger in every service?
   *
   * In production you will have no debugger. Your only window into what
   * happened is your logs. Every state transition, every error, every
   * external call should leave a trace. Winston (configured in Phase 1)
   * picks these up and ships them to your log aggregator.
   */
  private readonly logger = new Logger(InvoiceService.name);

  constructor(
    @InjectRepository(Invoice)
    private readonly invoiceRepo: Repository<Invoice>,

    @InjectRepository(Subscription)
    private readonly subscriptionRepo: Repository<Subscription>,
  ) { }

  // ─── Generate Invoice ────────────────────────────────────────────────────

  /**
   * Creates a new OPEN invoice for a subscription billing cycle.
   *
   * WHY no transaction here?
   * This method is ALWAYS called from within a transaction managed by
   * SubscriptionService (subscribe) or BillingScheduler (renew).
   * It's a pure write operation with no reads that need consistency.
   * The caller owns the transaction boundary.
   *
   * This is a key architectural principle: services that are called
   * FROM transactions don't create their own transactions.
   * Services that START a business operation own the transaction.
   */
  async generateInvoice(dto: GenerateInvoiceDto): Promise<Invoice> {
    this.logger.log(
      `Generating invoice for subscription ${dto.subscriptionId} — amount: ${dto.amount} ${dto.currency ?? 'USD'}`,
    );

    const invoice = this.invoiceRepo.create({
      subscription_id: dto.subscriptionId,
      customer_id: dto.customerId,
      amount: dto.amount,
      currency: dto.currency ?? 'USD',
      status: InvoiceStatus.OPEN,
      metadata: dto.metadata,
    });

    const saved = await this.invoiceRepo.save(invoice);

    this.logger.log(`Invoice ${saved.id} created with status OPEN`);
    return saved;
  }

  // ─── Mark as Paid ────────────────────────────────────────────────────────

  /**
   * Transitions an invoice from OPEN → PAID.
   * Called by BillingService.handleSuccess() after Stripe confirms payment.
   *
   * WHY validate the transition explicitly?
   * The database has no concept of "valid state transitions."
   * It will happily let you mark an already-PAID invoice as PAID again,
   * or mark a VOID invoice as PAID. That creates corrupted financial data.
   * The transition validator enforces your state machine at the service layer.
   *
   * WHY accept externalTransactionId here?
   * This is the Stripe/PayPal confirmation code. We store it on the invoice
   * as a quick reference even though the Payment entity also has it.
   * When an accountant asks "what Stripe charge does invoice X correspond to?"
   * they shouldn't need to join three tables to find out.
   */
  async markAsPaid(invoiceId: string, externalTransactionId: string): Promise<Invoice> {
    const invoice = await this.findOneOrFail(invoiceId);

    this.validateTransition(invoice, InvoiceStatus.PAID);

    invoice.status = InvoiceStatus.PAID;

    /**
     * WHY store externalTransactionId in metadata rather than a dedicated column?
     *
     * Two reasons:
     * 1. The Payment entity already has external_transaction_id as a dedicated,
     *    uniquely-indexed column. That's the source of truth.
     * 2. This is supplementary quick-reference data. Metadata is the right
     *    place for "useful to have" data that isn't queried or filtered on.
     */
    invoice.metadata = {
      ...invoice.metadata,
      paid_via_transaction: externalTransactionId,
      paid_at: new Date().toISOString(),
    };

    const updated = await this.invoiceRepo.save(invoice);

    this.logger.log(
      `Invoice ${invoiceId} marked as PAID — transaction: ${externalTransactionId}`,
    );

    return updated;
  }

  // ─── Mark as Uncollectible ───────────────────────────────────────────────

  /**
   * Transitions an invoice from OPEN → UNCOLLECTIBLE.
   * Called by BillingService after all retry attempts are exhausted.
   *
   * WHY "uncollectible" and not just "failed"?
   * This is the accounting term. It signals that you've made good-faith
   * attempts to collect and couldn't. It affects revenue recognition,
   * churn reporting, and dunning metrics. "failed" is too vague.
   *
   * WHY store failureReason in metadata?
   * "Card declined" vs "Card expired" vs "Insufficient funds" are different
   * business signals. Marketing might want to send different emails for each.
   * Storing the reason makes future automation possible.
   */
  async markAsUncollectible(invoiceId: string, failureReason?: string): Promise<Invoice> {
    const invoice = await this.findOneOrFail(invoiceId);

    this.validateTransition(invoice, InvoiceStatus.UNCOLLECTIBLE);

    invoice.status = InvoiceStatus.UNCOLLECTIBLE;
    invoice.metadata = {
      ...invoice.metadata,
      failure_reason: failureReason ?? 'All retry attempts exhausted',
      marked_uncollectible_at: new Date().toISOString(),
    };

    const updated = await this.invoiceRepo.save(invoice);

    this.logger.warn(
      `Invoice ${invoiceId} marked as UNCOLLECTIBLE — reason: ${failureReason}`,
    );

    return updated;
  }

  // ─── Void Invoice ────────────────────────────────────────────────────────

  /**
   * Transitions an invoice from OPEN → VOID.
   *
   * WHY have void separate from uncollectible?
   * VOID = we decided not to collect this (subscription cancelled before charge,
   *        duplicate invoice created by mistake, promotional credit applied).
   * UNCOLLECTIBLE = we TRIED to collect and failed.
   *
   * These are completely different business events with different reporting
   * implications. Conflating them destroys your financial reporting accuracy.
   */
  async voidInvoice(invoiceId: string, reason: string): Promise<Invoice> {
    const invoice = await this.findOneOrFail(invoiceId);

    this.validateTransition(invoice, InvoiceStatus.VOID);

    invoice.status = InvoiceStatus.VOID;
    invoice.metadata = {
      ...invoice.metadata,
      void_reason: reason,
      voided_at: new Date().toISOString(),
    };

    const updated = await this.invoiceRepo.save(invoice);

    this.logger.log(`Invoice ${invoiceId} voided — reason: ${reason}`);
    return updated;
  }

async markPaid(invoiceId: string, transactionId: string): Promise<Invoice> {
    // Delegates to existing markAsPaid — same logic, webhook-friendly name
    return this.markAsPaid(invoiceId, transactionId);
  }

  async markRefunded(invoiceId: string): Promise<Invoice> {
    const invoice = await this.findOneOrFail(invoiceId);
    this.validateTransition(invoice, InvoiceStatus.REFUNDED);

    invoice.status = InvoiceStatus.REFUNDED;
    invoice.metadata = {
      ...invoice.metadata,
      refunded_at: new Date().toISOString(),
    };

    const updated = await this.invoiceRepo.save(invoice);
    this.logger.log(`Invoice ${invoiceId} marked as REFUNDED`);
    return updated;
  }

  // ─── Query Methods ───────────────────────────────────────────────────────

  /**
   * WHY filter by status here instead of fetching all and filtering in app?
   *
   * "Fetch all then filter in JavaScript" is a pattern that works with 10 rows
   * and kills your database with 10 million. Always push filters to the query.
   * PostgreSQL's index on customer_id makes this a sub-millisecond lookup.
   */
  async getOpenInvoices(customerId: string): Promise<Invoice[]> {
    return this.invoiceRepo.find({
      where: {
        customer_id: customerId,
        status: InvoiceStatus.OPEN,
      },
      order: { created_at: 'ASC' }, // oldest first — charge in order
    });
  }

  async getInvoicesBySubscription(subscriptionId: string): Promise<Invoice[]> {
    return this.invoiceRepo.find({
      where: { subscription_id: subscriptionId },
      order: { created_at: 'DESC' },
    });
  }

  async findById(invoiceId: string): Promise<Invoice | null> {
    return this.invoiceRepo.findOne({ where: { id: invoiceId } });
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────

  /**
   * WHY a private findOneOrFail pattern?
   *
   * TypeORM's built-in findOneOrFail throws a generic EntityNotFoundError.
   * We want to throw our own InvoiceNotFoundException (domain exception)
   * with a meaningful message that includes the ID.
   *
   * Every service has this pattern for its primary entity.
   * It's 10 lines of code that saves hours of debugging "entity not found"
   * with no context about which entity or which ID.
   */
  private async findOneOrFail(invoiceId: string): Promise<Invoice> {
    const invoice = await this.invoiceRepo.findOne({
      where: { id: invoiceId },
    });

    if (!invoice) {
      throw new InvoiceNotFoundException(invoiceId);
    }

    return invoice;
  }

  /**
   * WHY centralize transition validation in one private method?
   *
   * If you inline this logic in every public method, you'll have:
   * - 4 copies of the same if-statement
   * - 4 places to update when you add a new state
   * - 4 opportunities for inconsistent error messages
   *
   * One method, one responsibility: "is this transition allowed?"
   */
  private validateTransition(invoice: Invoice, targetStatus: InvoiceStatus): void {
    const currentStatus = invoice.status as InvoiceStatus;
    const allowedTransitions = VALID_INVOICE_TRANSITIONS[currentStatus];

    if (!allowedTransitions.includes(targetStatus)) {
      throw new InvalidInvoiceStateException(
        invoice.id,
        currentStatus,
        `transition to ${targetStatus}`,
      );
    }
  }
}