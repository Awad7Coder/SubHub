/**
 * WHY define ALL state machines in enums before writing any service code?
 *
 * Because every service method is just a state transition with side effects.
 * If you don't know your states upfront, you'll add if-statements scattered
 * across three files and spend a week debugging why a cancelled subscription
 * got charged again.
 *
 * Draw the state machine FIRST. Code SECOND.
 */

// ─── Subscription States ────────────────────────────────────────────────────
//
//   pending ──→ active ──→ past_due ──→ cancelled
//                  │                        ↑
//                  └── (cancel_at_period_end flag set) ──→ cancelled (at period end)
//
// pending:    Created but first payment not confirmed yet
// active:     Paying customer, all good
// past_due:   Payment failed, retries in progress
// cancelled:  Terminal. No charges, no access.

export enum SubscriptionStatus {
  PENDING = 'pending',
  ACTIVE = 'active',
  PAST_DUE = 'past_due',
  CANCELLED = 'cancelled',
}

export const VALID_SUBSCRIPTION_TRANSITIONS: Record<
  SubscriptionStatus,
  SubscriptionStatus[]
> = {
  [SubscriptionStatus.PENDING]: [
    SubscriptionStatus.ACTIVE,      // first payment succeeded
    SubscriptionStatus.CANCELLED,   // cancelled before first payment
  ],
  [SubscriptionStatus.ACTIVE]: [
    SubscriptionStatus.PAST_DUE,    // payment failed
    SubscriptionStatus.CANCELLED,   // cancelled by user or admin
  ],
  [SubscriptionStatus.PAST_DUE]: [
    SubscriptionStatus.ACTIVE,      // retry succeeded — back to good standing
    SubscriptionStatus.CANCELLED,   // all retries exhausted
  ],
  [SubscriptionStatus.CANCELLED]: [], // terminal — no exits
};

// ─── Payment States ─────────────────────────────────────────────────────────

export enum PaymentStatus {
  PENDING = 'pending',
  SUCCEEDED = 'succeeded',
  FAILED = 'failed',
  REFUNDED = 'refunded',
}

// ─── Billing Queue Job Names ─────────────────────────────────────────────────
//
// WHY named constants for queue job names?
// BullMQ jobs are identified by string names. Typos ('chrage' vs 'charge')
// mean your processor never picks up the job — silent failure with no error.
// Constants make this a compile-time check instead of a runtime mystery.

export const BILLING_JOBS = {
  CHARGE_INVOICE: 'charge_invoice',
  RETRY_CHARGE: 'retry_charge',
  RENEWAL_CHECK: 'renewal_check',
} as const;

// ─── Retry Configuration ────────────────────────────────────────────────────
//
// WHY centralize retry config here instead of hardcoding in the processor?
// BillingService decides WHEN to retry. RetryProcessor executes the retry.
// Both need to agree on MAX_ATTEMPTS. One constant, zero drift.

export const BILLING_RETRY_CONFIG = {
  MAX_ATTEMPTS: 4,

  // Delays in milliseconds — exponential backoff
  // attempt 1 → 1 hour
  // attempt 2 → 6 hours
  // attempt 3 → 24 hours
  // attempt 4 → give up
  DELAYS_MS: [
    1 * 60 * 60 * 1000,   //  1 hour
    6 * 60 * 60 * 1000,   //  6 hours
    24 * 60 * 60 * 1000,  // 24 hours
  ],
} as const;