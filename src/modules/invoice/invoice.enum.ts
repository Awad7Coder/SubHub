/**
 * WHY enums instead of raw strings like 'open', 'paid'?
 *
 * If you use raw strings, nothing stops a junior engineer from writing
 * status = 'Open' (capital O) or status = 'PAID' somewhere.
 * Your queries silently return 0 rows and you spend 2 hours debugging.
 *
 * Enums make invalid states unrepresentable at the TypeScript level.
 * The compiler catches the mistake before it ever reaches the database.
 */

export enum InvoiceStatus {
  OPEN = 'open',
  PAID = 'paid',
  VOID = 'void',
  UNCOLLECTIBLE = 'uncollectible',
}

/**
 * WHY define valid transitions here?
 *
 * This is your state machine made explicit. Instead of scattered if-statements
 * across your service, you have one place that says:
 * "from OPEN you can go to PAID, VOID, or UNCOLLECTIBLE"
 * "from PAID you cannot go anywhere"
 *
 * Every transition check in InvoiceService uses this map.
 * Adding a new state? Update this map. One place, zero ambiguity.
 */
export const VALID_INVOICE_TRANSITIONS: Record<InvoiceStatus, InvoiceStatus[]> = {
  [InvoiceStatus.OPEN]: [
    InvoiceStatus.PAID,
    InvoiceStatus.VOID,
    InvoiceStatus.UNCOLLECTIBLE,
  ],
  [InvoiceStatus.PAID]: [],            // terminal state — no exits
  [InvoiceStatus.VOID]: [],            // terminal state — no exits
  [InvoiceStatus.UNCOLLECTIBLE]: [],   // terminal state — no exits
};