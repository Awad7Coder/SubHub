/**
 * WHY a custom exception hierarchy?
 *
 * NestJS has HttpException built in, but mixing HTTP concepts into your
 * service layer is a mistake. Your services should throw DOMAIN errors
 * ("invoice not found") not HTTP errors ("404").
 *
 * The controller's job is to catch domain exceptions and map them to
 * HTTP responses. This keeps your services testable without an HTTP context
 * and reusable if you ever add a gRPC or CLI interface.
 */

export class DomainException extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

// ─── Invoice Exceptions ────────────────────────────────────────────────────

export class InvoiceNotFoundException extends DomainException {
  constructor(invoiceId: string) {
    super(`Invoice ${invoiceId} not found`);
  }
}

export class InvalidInvoiceStateException extends DomainException {
  /**
   * WHY track current and attempted state?
   * When this lands in your logs, you want to know:
   * "someone tried to mark a PAID invoice as paid again"
   * not just "invalid state". Context = faster debugging.
   */
  constructor(invoiceId: string, currentState: string, attemptedAction: string) {
    super(
      `Cannot perform '${attemptedAction}' on invoice ${invoiceId} — current state is '${currentState}'`,
    );
  }
}

// ─── Subscription Exceptions ───────────────────────────────────────────────

export class SubscriptionNotFoundException extends DomainException {
  constructor(subscriptionId: string) {
    super(`Subscription ${subscriptionId} not found`);
  }
}

export class DuplicateSubscriptionException extends DomainException {
  constructor(customerId: string) {
    super(`Customer ${customerId} already has an active subscription`);
  }
}

// ─── Usage Exceptions ─────────────────────────────────────────────────────

export class UsageLimitExceededException extends DomainException {
  /**
   * WHY expose current and limit in the exception?
   * The API layer can use these numbers to build a helpful response:
   * "You've used 100/100 api_calls this period. Upgrade to Pro for more."
   * A generic "limit exceeded" message is useless to the client.
   */
  constructor(
    subscriptionId: string,
    actionType: string,
    current: number,
    limit: number,
  ) {
    super(
      `Usage limit exceeded for '${actionType}' on subscription ${subscriptionId}: ${current}/${limit}`,
    );
    this.current = current;
    this.limit = limit;
    this.actionType = actionType;
  }

  readonly current: number;
  readonly limit: number;
  readonly actionType: string;
}

// ─── Customer Exceptions ───────────────────────────────────────────────────

export class CustomerNotFoundException extends DomainException {
  constructor(customerId: string) {
    super(`Customer ${customerId} not found`);
  }
}

export class InactiveCustomerException extends DomainException {
  constructor(customerId: string) {
    super(`Customer ${customerId} is not active`);
  }
}

// ─── Plan Exceptions ───────────────────────────────────────────────────────

export class PlanNotFoundException extends DomainException {
  constructor(planId: string) {
    super(`Plan ${planId} not found`);
  }
}

export class InactivePlanException extends DomainException {
  constructor(planId: string) {
    super(`Plan ${planId} is not active`);
  }
}