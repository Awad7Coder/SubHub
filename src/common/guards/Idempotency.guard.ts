import {
  CanActivate,
  ExecutionContext,
  Injectable,
  BadRequestException,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';

/**
 * WHY a separate guard to REQUIRE the key, when the interceptor handles
 * what to DO with the key?
 *
 * Single responsibility:
 *   IdempotencyInterceptor → "if a key exists, enforce idempotency semantics"
 *   RequiresIdempotencyGuard → "this endpoint MUST have a key"
 *
 * If you merged these, the interceptor would need to know which endpoints
 * are "required" vs "optional" — coupling transport logic with route config.
 *
 * With the decorator pattern:
 *   @UseGuards(RequiresIdempotencyGuard)   ← requires key or 400
 *   @UseInterceptors(IdempotencyInterceptor) ← handles the key
 *   @Post('/subscriptions')
 *   async subscribe() { ... }
 *
 * Guards run BEFORE interceptors in NestJS execution order:
 *   Middleware → Guards → Interceptors (pre) → Handler → Interceptors (post)
 *
 * So the guard rejects missing keys before the interceptor even runs.
 * Clean separation, correct execution order.
 */

export const REQUIRES_IDEMPOTENCY_KEY = 'requires_idempotency_key';

/**
 * Decorator to mark endpoints that require an Idempotency-Key header.
 * Use on any endpoint that triggers a payment or creates a billable resource.
 *
 * Usage:
 *   @RequiresIdempotencyKey()
 *   @Post('/subscriptions')
 *   async subscribe() { ... }
 */
export const RequiresIdempotencyKey = () =>
  SetMetadata(REQUIRES_IDEMPOTENCY_KEY, true);

@Injectable()
export class RequiresIdempotencyGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<boolean>(
      REQUIRES_IDEMPOTENCY_KEY,
      [context.getHandler(), context.getClass()],
    );

    // Route not decorated → idempotency key is optional → allow through
    if (!required) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const key = request.headers['idempotency-key'];

    if (!key) {
      throw new BadRequestException({
        message: 'Idempotency-Key header is required for this endpoint',
        code: 'IDEMPOTENCY_KEY_MISSING',
        hint: 'Generate a UUID and pass it as the Idempotency-Key header. Reuse the same key if retrying.',
      });
    }

    return true;
  }
}