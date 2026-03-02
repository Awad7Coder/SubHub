import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
  UnprocessableEntityException,
  BadRequestException,
} from '@nestjs/common';
import { Observable, from, of } from 'rxjs';
import { switchMap, tap } from 'rxjs/operators';
import { Request, Response } from 'express';
import { IdempotencyService } from 'src/modules/idempotency/idempotency.server';


/**
 * INTERCEPTOR vs MIDDLEWARE vs GUARD — why an interceptor?
 *
 * Middleware: runs before routing. No access to the response body.
 *   → Can't cache the response. Eliminated.
 *
 * Guard: decides whether to proceed. Returns boolean or throws.
 *   → Can block the request (key+hash mismatch) but can't return
 *     a cached response in place of the controller result. Eliminated.
 *
 * Interceptor: wraps the entire handler execution. Has access to BOTH
 *   the incoming request AND the outgoing response stream.
 *   → Can short-circuit the handler and return cached data.
 *   → Can tap the response stream to cache the result after the handler runs.
 *   ✅ Only interceptors can do both. This is the correct abstraction.
 *
 * The flow looks like this:
 *
 *   Request
 *     ↓
 *   [IdempotencyInterceptor — PRE]
 *     ↓ key not found? proceed
 *     ↓ key found + hash match? → return cached response (skip controller)
 *     ↓ key found + hash mismatch? → throw 422 (skip controller)
 *   [Controller Handler]
 *     ↓ response stream
 *   [IdempotencyInterceptor — POST]
 *     ↓ store response in idempotency_keys
 *   Response
 */

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  /**
   * WHY the header name 'idempotency-key' (lowercase)?
   * HTTP headers are case-insensitive per the spec. Express normalizes
   * all incoming headers to lowercase, so req.headers['Idempotency-Key']
   * always returns undefined — you must use lowercase to read from Express.
   * We use the same casing Stripe uses: 'idempotency-key'.
   */
  private readonly HEADER_NAME = 'idempotency-key';

  /**
   * WHY a max key length?
   * Without a limit, a client could send a 10MB string as the key,
   * which gets stored in your DB and indexed. Bounding it at 512 chars
   * matches your entity's varchar(512) definition and prevents abuse.
   */
  private readonly MAX_KEY_LENGTH = 512;

  constructor(private readonly idempotencyService: IdempotencyService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();

    const idempotencyKey = request.headers[this.HEADER_NAME] as string | undefined;

    /**
     * WHY return next.handle() immediately if no key is present?
     *
     * Idempotency keys are OPTIONAL on most endpoints but REQUIRED
     * on payment-triggering endpoints. The enforcement of "required"
     * is done at the controller level with a separate guard or validation,
     * NOT here in the interceptor.
     *
     * The interceptor's job is: "if a key is present, enforce idempotency."
     * It is NOT the interceptor's job to decide which endpoints require keys.
     * Single responsibility principle.
     */
    if (!idempotencyKey) {
      return next.handle();
    }

    // ── Validate the key itself ───────────────────────────────────────────
    if (idempotencyKey.length > this.MAX_KEY_LENGTH) {
      throw new BadRequestException(
        `Idempotency-Key exceeds maximum length of ${this.MAX_KEY_LENGTH} characters`,
      );
    }

    /**
     * WHY hash the body and not the full URL?
     * The URL is already captured by the route — the key is scoped
     * to one endpoint per client convention. The body is what changes
     * between legitimate vs malicious retries.
     *
     * Including the URL in the hash would mean the same key on
     * POST /subscriptions and POST /payments/retry would be treated
     * as different operations. That's actually correct behavior, but
     * it's the client's responsibility to use different keys per endpoint,
     * not ours to enforce via URL hashing.
     */
    const requestHash = this.idempotencyService.hashRequest(request.body ?? {});

    /**
     * WHY convert the async check() to an Observable with from()?
     *
     * NestJS interceptors must return Observable<any>.
     * Our IdempotencyService uses async/await (returns Promises).
     * from() wraps a Promise in an Observable.
     * switchMap() then decides what Observable to return next:
     *   - cached response → of(cached.body) — short-circuits the handler
     *   - no cache → next.handle() — runs the controller normally
     *
     * This is the RxJS way to do "async pre-processing then branch."
     */
    return from(this.idempotencyService.check(idempotencyKey, requestHash)).pipe(
      switchMap((result) => {

        // ── Case 1: Key reused with different body → reject ───────────────
        if (result.found && !result.hashMatch) {
          /**
           * WHY 422 Unprocessable Entity and not 409 Conflict?
           * 409 Conflict means "resource state conflict" (like trying to
           * create something that already exists).
           * 422 means "the request is syntactically valid but semantically
           * wrong" — the key was valid, the body was valid, but TOGETHER
           * they violate the idempotency contract.
           * Stripe uses 422 for this case. We follow the same convention.
           */
          throw new UnprocessableEntityException({
            message: 'Idempotency key has already been used with a different request body',
            code: 'IDEMPOTENCY_KEY_REUSED',
            hint: 'Use a new unique key for a different request, or retry with the exact original request body',
          });
        }

        // ── Case 2: Valid cached response → return it ─────────────────────
        if (result.found && result.hashMatch && result.cached) {
          this.logger.log(
            `[IDEMPOTENT REPLAY] key=${idempotencyKey} → returning cached ${result.cached.statusCode}`,
          );

          /**
           * WHY set the status code on the response object directly?
           * of(result.cached.body) creates an Observable that emits the
           * cached body. NestJS will serialize this as a 200 by default.
           * But the original response might have been a 201 (Created).
           * We set the status code explicitly to match the original.
           *
           * WHY add the X-Idempotent-Replayed header?
           * This tells the client "you got a cached response, not a fresh one."
           * Essential for debugging — clients can log this header to understand
           * why their request returned instantly instead of processing.
           */
          response.status(result.cached.statusCode);
          response.setHeader('X-Idempotent-Replayed', 'true');
          response.setHeader('X-Idempotency-Key', idempotencyKey);

          return of(result.cached.body);
        }

        // ── Case 3: Key not found → run controller, then cache ────────────
        return next.handle().pipe(
          tap({
            /**
             * WHY tap() and not map()?
             * map() transforms the value in the stream.
             * tap() observes the value without changing it — perfect for
             * side effects like caching. The response flows through unchanged;
             * we just intercept it to store a copy.
             *
             * WHY next() and not complete()?
             * tap() has three callbacks: next (value emitted), error (stream errored),
             * complete (stream done). We only cache on next() — successful responses.
             * Errors should NOT be cached unless you explicitly want to replay errors.
             * For billing, replaying a "card declined" error is fine; replaying
             * a 500 Internal Server Error is not.
             */
            next: async (responseBody) => {
              const statusCode = response.statusCode;

              /**
               * WHY only cache 2xx responses?
               * 4xx errors (validation, not found) can be cached — the same
               * bad request will always get the same bad response.
               * 5xx errors should NOT be cached — they indicate something
               * went wrong on OUR side. The client should be able to retry
               * and potentially get a success on the next attempt.
               *
               * Caching a 500 would mean a client who hit our service during
               * a brief outage gets a permanently cached failure. Never acceptable.
               */
              if (statusCode >= 200 && statusCode < 500) {
                try {
                  await this.idempotencyService.store(
                    idempotencyKey,
                    requestHash,
                    statusCode,
                    responseBody,
                  );

                  response.setHeader('X-Idempotency-Key', idempotencyKey);
                } catch (error) {
                  /**
                   * WHY catch and log instead of re-throwing?
                   * The controller already ran successfully. The customer's
                   * subscription was created, the invoice was generated.
                   * Failing to cache the idempotency response is a problem
                   * but NOT a reason to return a 500 to the client.
                   *
                   * Worst case: caching fails, the client retries, the duplicate
                   * check in SubscriptionService catches it (DuplicateSubscriptionException).
                   * The system remains consistent. Log the cache failure for ops
                   * visibility but don't surface it to the client.
                   */
                  this.logger.error(
                    `Failed to store idempotency response for key ${idempotencyKey}: ${error.message}`,
                  );
                }
              }
            },
          }),
        );
      }),
    );
  }
}