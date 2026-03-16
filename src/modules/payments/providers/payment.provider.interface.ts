/**
 * payment-provider.interface.ts
 *
 * This file is the CONTRACT between BillingService and any payment provider.
 * BillingService imports ONLY from this file — never from stripe, paypal, etc.
 *
 * Rule: if you find yourself importing Stripe types in billing.service.ts,
 * something is wrong. Push it back into the provider implementation.
 */

// ─── Unified Result Types ──────────────────────────────────────────────────

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

// ─── Unified Domain Errors ─────────────────────────────────────────────────

/**
 * Card declined, expired, insufficient funds.
 * CUSTOMER-FACING: safe to include message in notification email.
 * NOT a retry candidate with the same card — customer must act.
 */
export class PaymentDeclinedException extends Error {
  constructor(
    public readonly reason: string,
    public readonly declineCode?: string,
  ) {
    super(`Payment declined: ${reason}`);
    this.name = 'PaymentDeclinedException';
  }
}

/**
 * Provider is down, rate limited, network timeout.
 * INTERNAL: do not surface to customer — not their fault.
 * IS a retry candidate — provider may recover.
 * Circuit breaker tracks this exception type.
 */
export class ProviderUnavailableException extends Error {
  constructor(
    public readonly provider: string,
    public readonly originalError?: Error,
  ) {
    super(`Payment provider '${provider}' is currently unavailable`);
    this.name = 'ProviderUnavailableException';
  }
}

/**
 * Our API key is wrong, currency not supported, invalid params.
 * INTERNAL: ops alert needed.
 * NOT a retry candidate — retrying won't fix a config problem.
 */
export class PaymentConfigurationException extends Error {
  constructor(public readonly detail: string) {
    super(`Payment configuration error: ${detail}`);
    this.name = 'PaymentConfigurationException';
  }
}

// ─── The Interface ─────────────────────────────────────────────────────────

export const PAYMENT_PROVIDER = 'PAYMENT_PROVIDER';

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