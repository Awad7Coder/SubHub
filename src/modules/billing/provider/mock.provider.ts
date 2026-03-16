import { Injectable } from '@nestjs/common';

// ─── Unified Domain Errors ─────────────────────────────────────────────────
// These must match whatever you define in your PaymentProvider interface.
// If you already have these in a shared file, import from there instead.

export class PaymentDeclinedException extends Error {
  constructor(
    public readonly reason: string,
    public readonly declineCode?: string,
  ) {
    super(`Payment declined: ${reason}`);
    this.name = 'PaymentDeclinedException';
  }
}

export class ProviderUnavailableException extends Error {
  constructor(public readonly provider: string) {
    super(`Payment provider '${provider}' is currently unavailable`);
    this.name = 'ProviderUnavailableException';
  }
}

// ─── Result Types ──────────────────────────────────────────────────────────

export interface ChargeResult {
  success: boolean;
  transactionId: string;
  amount: number;
  currency: string;
  processedAt: Date;
}

export interface RefundResult {
  success: boolean;
  refundId: string;
  amount: number;
  processedAt: Date;
}

// ─── Payment Provider Interface ────────────────────────────────────────────

export interface PaymentProvider {
  readonly name: string;
  charge(params: {
    amount: number;
    currency: string;
    customerId: string;
    invoiceId: string;
    idempotencyKey: string;
  }): Promise<ChargeResult>;
  refund(params: {
    transactionId: string;
    amount?: number;
    reason?: string;
  }): Promise<RefundResult>;
  healthCheck(): Promise<boolean>;
}

// ─── Mock Implementation ───────────────────────────────────────────────────

/**
 * WHY MockPaymentProvider instead of mocking BillingService directly?
 *
 * We want to test the FULL billing flow:
 *   SubscriptionService → BillingService → PaymentProvider
 *
 * If we mock BillingService, we don't test whether BillingService
 * correctly handles declines, retries, and state transitions.
 *
 * By only replacing the PaymentProvider (the external boundary),
 * all the real business logic runs — we just control what "Stripe" returns.
 *
 * USAGE IN TESTS:
 *
 *   // Simulate card declined
 *   mockProvider.shouldDecline = true;
 *   await billingService.attemptCharge(invoiceId, 1);
 *   expect(invoice.status).toBe(InvoiceStatus.OPEN); // still open, retry scheduled
 *
 *   // Simulate provider down
 *   mockProvider.shouldBeUnavailable = true;
 *   await billingService.attemptCharge(invoiceId, 1);
 *   // circuit breaker should register the failure
 *
 *   // Inspect what was charged
 *   expect(mockProvider.capturedCharges[0].amount).toBe(99.00);
 */
@Injectable()
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';

  // ── Test Controls ─────────────────────────────────────────────────────
  // Set these in your test before calling the method under test

  shouldDecline = false;
  shouldBeUnavailable = false;
  chargeDelayMs = 0;

  // ── Captured Data ─────────────────────────────────────────────────────
  // Inspect these after calling to verify what was sent to the provider

  capturedCharges: Array<{
    amount: number;
    currency: string;
    customerId: string;
    invoiceId: string;
    idempotencyKey: string;
  }> = [];

  capturedRefunds: Array<{
    transactionId: string;
    amount?: number;
    reason?: string;
  }> = [];

  // ── charge() ──────────────────────────────────────────────────────────

  async charge(params: {
    amount: number;
    currency: string;
    customerId: string;
    invoiceId: string;
    idempotencyKey: string;
  }): Promise<ChargeResult> {
    // Record the call — useful for asserting correct params were passed
    this.capturedCharges.push(params);

    // Simulate network latency if needed
    if (this.chargeDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.chargeDelayMs));
    }

    if (this.shouldBeUnavailable) {
      throw new ProviderUnavailableException('mock');
    }

    if (this.shouldDecline) {
      throw new PaymentDeclinedException('Card declined', 'card_declined');
    }

    return {
      success: true,
      transactionId: `mock_tx_${Date.now()}_${params.invoiceId.slice(0, 8)}`,
      amount: params.amount,
      currency: params.currency,
      processedAt: new Date(),
    };
  }

  // ── refund() ──────────────────────────────────────────────────────────

  async refund(params: {
    transactionId: string;
    amount?: number;
    reason?: string;
  }): Promise<RefundResult> {
    this.capturedRefunds.push(params);

    return {
      success: true,
      refundId: `mock_re_${Date.now()}`,
      amount: params.amount ?? 0,
      processedAt: new Date(),
    };
  }

  // ── healthCheck() ─────────────────────────────────────────────────────

  async healthCheck(): Promise<boolean> {
    return !this.shouldBeUnavailable;
  }

  // ── reset() ───────────────────────────────────────────────────────────

  /**
   * Call this in beforeEach() to get a clean provider for each test.
   * Without reset(), state from test A bleeds into test B.
   */
  reset(): void {
    this.shouldDecline = false;
    this.shouldBeUnavailable = false;
    this.chargeDelayMs = 0;
    this.capturedCharges = [];
    this.capturedRefunds = [];
  }
}