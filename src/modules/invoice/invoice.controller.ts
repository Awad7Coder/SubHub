import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
} from '@nestjs/common';
import { InvoiceService } from './invoice.service';

import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
/**
 * WHY no IdempotencyInterceptor on InvoicesController?
 *
 * Invoices are READ-ONLY from the API perspective.
 * GET requests are idempotent by HTTP spec — calling the same GET
 * twice always returns the same resource (or 404 if it doesn't exist).
 * No state changes, no charges, no idempotency layer needed.
 *
 * Idempotency protection costs a DB lookup on every request.
 * Don't pay that cost where it provides zero safety benefit.
 */

@ApiTags('invoices')
@Controller('invoices')
export class InvoicesController {
  constructor(private readonly invoiceService: InvoiceService) { }

  // ── GET /api/invoices/:id ───────────────────────────────────────────────

  @Get(':id')
  @ApiOperation({ summary: 'Get invoice by ID' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Invoice found' })
  @ApiResponse({ status: 404, description: 'Invoice not found' })
  async findById(@Param('id', ParseUUIDPipe) id: string) {
    /**
     * WHY not check ownership here (does this invoice belong to the caller)?
     *
     * Authorization (does THIS user own this resource?) is a separate
     * concern from the controller's job (handle the HTTP request).
     * In a production system you'd have an AuthGuard that attaches the
     * authenticated user to the request, and then either:
     * 1. A resource-level guard checks ownership
     * 2. The service method filters by both id AND customer_id from auth context
     *
     * We're building the billing engine, not the auth system.
     * Ownership checks get added when auth is wired in.
     */
    return this.invoiceService.findById(id);
  }

  // ── GET /api/invoices/customer/:customerId ─────────────────────────────

  /**
   * WHY return only OPEN invoices on this route?
   * This endpoint is designed for the "outstanding balance" UI component —
   * showing what the customer currently owes. Paid/void invoices are
   * financial history, accessed via a different route if needed.
   *
   * Keeping the purpose narrow keeps the response small and fast.
   * A customer with 3 years of billing history might have 36 paid invoices.
   * The client asking "what do I owe?" doesn't need all 36.
   */
  @Get('customer/:customerId/open')
  @ApiOperation({
    summary: 'Get open (unpaid) invoices for a customer',
    description: 'Returns all invoices with status=OPEN, ordered oldest first (charge in order).',
  })
  @ApiParam({ name: 'customerId', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Open invoice list (may be empty)' })
  async getOpenInvoices(
    @Param('customerId', ParseUUIDPipe) customerId: string,
  ) {
    return this.invoiceService.getOpenInvoices(customerId);
  }

  // ── GET /api/invoices/subscription/:subscriptionId ─────────────────────

  /**
   * Returns the full invoice history for a subscription.
   * Useful for the billing history page — shows all charges over time.
   */
  @Get('subscription/:subscriptionId')
  @ApiOperation({
    summary: 'Get all invoices for a subscription',
    description: 'Returns full billing history, newest first. Bounded by billing cycles — safe to return all.',
  })
  @ApiParam({ name: 'subscriptionId', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Invoice list (may be empty)' })
  async getBySubscription(
    @Param('subscriptionId', ParseUUIDPipe) subscriptionId: string,
  ) {
    return this.invoiceService.getInvoicesBySubscription(subscriptionId);
  }

}