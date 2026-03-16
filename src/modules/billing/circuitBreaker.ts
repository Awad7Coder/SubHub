import { Injectable, Logger } from '@nestjs/common';

/**
 * WHY build a circuit breaker?
 *
 * Picture this: Stripe goes down at 2am. Your retry queue has 10,000 jobs.
 * Without a circuit breaker, all 10,000 jobs immediately hammer Stripe's
 * already-struggling API, making the outage worse and burning through
 * your retry budget in minutes.
 *
 * The circuit breaker detects the outage after N failures and OPENS —
 * meaning all subsequent calls fail immediately without touching Stripe.
 * After a cooldown, it allows ONE test request through (HALF_OPEN).
 * If that succeeds, it CLOSES again and normal traffic resumes.
 *
 * ┌─────────┐   N failures    ┌──────┐
 * │ CLOSED  │ ─────────────→  │ OPEN │
 * │(normal) │                 │(fast │
 * └─────────┘                 │ fail)│
 *      ↑                      └──────┘
 *      │  success                 │
 *      │                  cooldown│
 *      │                          ↓
 * ┌───────────┐            ┌───────────┐
 * │ HALF_OPEN │ ←──────────│  OPEN     │
 * │(1 test    │            │(waiting)  │
 * │ request)  │            └───────────┘
 * └───────────┘
 *
 * WHY build it manually instead of using 'opossum' library?
 * Two reasons:
 * 1. You understand EXACTLY what it does — no black box in your money flow.
 * 2. This version is tailored to your domain: it tracks per-provider state,
 *    integrates with your logger, and sends internal alerts on state changes.
 *
 * For production at scale, opossum is excellent. For learning, build it once.
 */

export enum CircuitState {
  CLOSED = 'CLOSED',       // normal — requests flow through
  OPEN = 'OPEN',           // tripped — requests fail immediately
  HALF_OPEN = 'HALF_OPEN', // testing — one request allowed through
}

export class CircuitBreakerOpenException extends Error {
  constructor(provider: string) {
    super(
      `Circuit breaker is OPEN for provider '${provider}'. ` +
      `External calls are suspended. Will retry after cooldown.`,
    );
    this.name = 'CircuitBreakerOpenException';
  }
}

interface CircuitBreakerOptions {
  failureThreshold?: number;    // how many failures before OPEN (default: 5)
  cooldownMs?: number;          // how long to stay OPEN before HALF_OPEN (default: 60s)
  provider?: string;            // label for logging
}

@Injectable()
export class CircuitBreaker {
  private readonly logger = new Logger(CircuitBreaker.name);

  private state: CircuitState = CircuitState.CLOSED;
  private failureCount = 0;
  private lastFailureTime?: Date;

  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly provider: string;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.cooldownMs = options.cooldownMs ?? 60_000;
    this.provider = options.provider ?? 'unknown';
  }

  /**
   * The main entry point. Wraps any async call with circuit breaker logic.
   *
   * Usage:
   *   const result = await circuitBreaker.call(() => stripe.charge(params));
   *
   * WHY accept a function instead of the result directly?
   * We need to control WHEN the external call is made.
   * If we accepted the result: stripe.charge() would already be called
   * before we could check the circuit state. The function lets us
   * decide whether to invoke it at all.
   */
  
  async call<T>(fn: () => Promise<T>): Promise<T> {
    this.evaluateState();

    if (this.state === CircuitState.OPEN) {
      throw new CircuitBreakerOpenException(this.provider);
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error; // always re-throw — circuit breaker observes, not swallows
    }
  }

  // ─── State Inspection ────────────────────────────────────────────────────

  getState(): CircuitState {
    this.evaluateState();
    return this.state;
  }

  isOpen(): boolean {
    return this.getState() === CircuitState.OPEN;
  }

  // ─── Private State Machine ───────────────────────────────────────────────

  /**
   * WHY call evaluateState() at the START of every call?
   *
   * The circuit breaker is time-based. It doesn't transition from OPEN to
   * HALF_OPEN on a timer — it transitions lazily, the next time someone
   * asks. This avoids background timers and keeps the class stateless
   * except for the failure count and last failure time.
   */
  private evaluateState(): void {
    if (this.state !== CircuitState.OPEN) return;
    if (!this.lastFailureTime) return;

    const elapsed = Date.now() - this.lastFailureTime.getTime();

    if (elapsed >= this.cooldownMs) {
      this.logger.log(
        `[CircuitBreaker:${this.provider}] Cooldown elapsed — transitioning OPEN → HALF_OPEN`,
      );
      this.state = CircuitState.HALF_OPEN;
    }
  }

  private onSuccess(): void {
    if (this.state === CircuitState.HALF_OPEN) {
      this.logger.log(
        `[CircuitBreaker:${this.provider}] Test request succeeded — transitioning HALF_OPEN → CLOSED`,
      );
    }

    // Reset everything on any success
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.lastFailureTime = undefined;
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = new Date();

    this.logger.warn(
      `[CircuitBreaker:${this.provider}] Failure ${this.failureCount}/${this.failureThreshold}`,
    );

    if (this.state === CircuitState.HALF_OPEN) {
      /**
       * WHY immediately re-OPEN on HALF_OPEN failure?
       * The test request failed — the provider is still down.
       * Go back to OPEN immediately and restart the cooldown timer.
       * No point letting more requests through.
       */
      this.logger.error(
        `[CircuitBreaker:${this.provider}] Test request failed — transitioning HALF_OPEN → OPEN`,
      );
      this.state = CircuitState.OPEN;
      return;
    }

    if (this.failureCount >= this.failureThreshold) {
      this.logger.error(
        `[CircuitBreaker:${this.provider}] Threshold reached (${this.failureThreshold}) — transitioning CLOSED → OPEN`,
      );
      this.state = CircuitState.OPEN;
    }
  }
}