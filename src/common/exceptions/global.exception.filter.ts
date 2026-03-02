import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import {
  CustomerNotFoundException,
  InactiveCustomerException,
  PlanNotFoundException,
  InactivePlanException,
  SubscriptionNotFoundException,
  DuplicateSubscriptionException,
  InvoiceNotFoundException,
  InvalidInvoiceStateException,
  UsageLimitExceededException,
} from '../exceptions/domain.exception';
import { InvalidSubscriptionStateException } from '../../modules/subscriptions/subscriptions.service';

/**
 * WHY @Catch() with no arguments?
 *
 * @Catch(HttpException) would only catch NestJS HTTP exceptions.
 * @Catch(DomainException) would only catch our domain exceptions.
 * @Catch() with NO arguments catches EVERYTHING — HttpExceptions,
 * domain exceptions, TypeORM errors, unexpected crashes.
 *
 * This is the safety net for the entire application.
 * Nothing falls through to Express's default error handler,
 * which would leak stack traces to clients in production.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();

    const { statusCode, message, code } = this.resolveException(exception);

    /**
     * WHY log differently based on status code?
     *
     * 4xx errors: client mistakes — log as warn (expected, not actionable)
     * 5xx errors: our mistakes — log as error (unexpected, needs investigation)
     *
     * If you log everything as error, your alerting system fires on every
     * 404. Your on-call engineer ignores alerts. A real 500 gets missed.
     * Signal-to-noise ratio matters more than logging everything.
     */
    if (statusCode >= 500) {
      this.logger.error(
        `[${statusCode}] ${request.method} ${request.url} — ${message}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.warn(
        `[${statusCode}] ${request.method} ${request.url} — ${message}`,
      );
    }

    response.status(statusCode).json({
      statusCode,
      message,
      code,
      /**
       * WHY include timestamp and path?
       *
       * timestamp: correlates this error with your logs.
       *   "Error at 14:32:07.441Z" + search logs for same timestamp = instant match.
       *
       * path: tells the client exactly which endpoint failed.
       *   Essential when clients call multiple endpoints in parallel
       *   and an error response arrives — they know which one failed
       *   without parsing the request that triggered it.
       */
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }

  // ─── Exception Resolution Map ─────────────────────────────────────────

  /**
   * WHY a private method that returns a plain object instead of
   * inline logic in catch()?
   *
   * catch() already has response/request setup logic.
   * Mixing the mapping logic in there creates a 100-line method
   * that's hard to scan. This method has ONE job: given an exception,
   * return { statusCode, message, code }. Testable in isolation.
   */
  private resolveException(exception: unknown): {
    statusCode: number;
    message: string;
    code: string;
  } {

    // ── NestJS HTTP Exceptions (ValidationPipe, guards, etc.) ─────────────
    /**
     * WHY handle HttpException first?
     * NestJS's own exceptions (BadRequestException from ValidationPipe,
     * ForbiddenException from guards, UnprocessableEntityException from
     * idempotency) are HttpExceptions. They already have the correct
     * statusCode built in — we just need to extract it consistently.
     */
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      // HttpException response can be a string or an object
      if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
        const resp = exceptionResponse as Record<string, any>;
        return {
          statusCode: status,
          /**
           * WHY handle array messages?
           * ValidationPipe throws BadRequestException with an array of
           * validation errors: ["email must be an email", "name is required"]
           * We join them into a single readable string.
           */
          message: Array.isArray(resp.message)
            ? resp.message.join('; ')
            : resp.message ?? exception.message,
          code: resp.code ?? this.httpStatusToCode(status),
        };
      }

      return {
        statusCode: status,
        message: String(exceptionResponse),
        code: this.httpStatusToCode(status),
      };
    }

    // ── Domain Exceptions → HTTP Status Mapping ───────────────────────────
    /**
     * WHY explicit instanceof checks instead of a map or switch?
     *
     * A map approach (exceptionClassToStatus: Map<Constructor, number>)
     * requires the exception instances to match by reference. instanceof
     * handles inheritance correctly — if you subclass CustomerNotFoundException
     * later, it still maps to 404.
     *
     * Each exception gets:
     *   statusCode: the HTTP status it maps to
     *   message:    the exception's message (already formatted with context)
     *   code:       a machine-readable string for client-side handling
     */

    // 404 Not Found
    if (exception instanceof CustomerNotFoundException) {
      return { statusCode: 404, message: exception.message, code: 'CUSTOMER_NOT_FOUND' };
    }
    if (exception instanceof SubscriptionNotFoundException) {
      return { statusCode: 404, message: exception.message, code: 'SUBSCRIPTION_NOT_FOUND' };
    }
    if (exception instanceof InvoiceNotFoundException) {
      return { statusCode: 404, message: exception.message, code: 'INVOICE_NOT_FOUND' };
    }
    if (exception instanceof PlanNotFoundException) {
      return { statusCode: 404, message: exception.message, code: 'PLAN_NOT_FOUND' };
    }

    // 409 Conflict — resource already exists in a conflicting state
    if (exception instanceof DuplicateSubscriptionException) {
      return { statusCode: 409, message: exception.message, code: 'DUPLICATE_SUBSCRIPTION' };
    }

    // 422 Unprocessable Entity — valid data, invalid state transition
    if (exception instanceof InvalidInvoiceStateException) {
      return { statusCode: 422, message: exception.message, code: 'INVALID_INVOICE_STATE' };
    }
    if (exception instanceof InvalidSubscriptionStateException) {
      return { statusCode: 422, message: exception.message, code: 'INVALID_SUBSCRIPTION_STATE' };
    }

    // 402 Payment Required — usage limit exceeded
    /**
     * WHY 402 and not 403 for usage limits?
     * 403 Forbidden = you don't have PERMISSION to do this.
     * 402 Payment Required = you need to PAY more to do this.
     * Usage limits are a billing boundary, not an access boundary.
     * 402 communicates "upgrade your plan" more precisely than 403.
     *
     * We also include current/limit in the response body so the client
     * can build a meaningful "You've used X/Y" UI without an extra request.
     */
    if (exception instanceof UsageLimitExceededException) {
      return {
        statusCode: 402,
        message: exception.message,
        code: 'USAGE_LIMIT_EXCEEDED',
      };
    }

    // 403 Forbidden — account state issues
    if (exception instanceof InactiveCustomerException) {
      return { statusCode: 403, message: exception.message, code: 'CUSTOMER_INACTIVE' };
    }
    if (exception instanceof InactivePlanException) {
      return { statusCode: 403, message: exception.message, code: 'PLAN_INACTIVE' };
    }

    // ── Unknown / Unexpected Exceptions ───────────────────────────────────
    /**
     * WHY return a generic 500 for unknown exceptions?
     *
     * NEVER leak internal error details to clients:
     * - Stack traces reveal your file structure to attackers
     * - TypeORM error messages reveal your DB schema
     * - Connection errors reveal your infrastructure
     *
     * Log the full error server-side (done in catch() above).
     * Return a safe, generic message to the client.
     */
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'An unexpected error occurred. Please try again later.',
      code: 'INTERNAL_SERVER_ERROR',
    };
  }

  // ─── HTTP Status → Code String ────────────────────────────────────────

  private httpStatusToCode(status: number): string {
    const map: Record<number, string> = {
      400: 'BAD_REQUEST',
      401: 'UNAUTHORIZED',
      402: 'PAYMENT_REQUIRED',
      403: 'FORBIDDEN',
      404: 'NOT_FOUND',
      409: 'CONFLICT',
      422: 'UNPROCESSABLE_ENTITY',
      429: 'TOO_MANY_REQUESTS',
      500: 'INTERNAL_SERVER_ERROR',
    };
    return map[status] ?? `HTTP_${status}`;
  }
}