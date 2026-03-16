import { Throttle, SkipThrottle } from '@nestjs/throttler';
import { THROTTLE_DEFAULTS } from 'src/config/throttler.config';


/**
 * Apply this decorator to any endpoint that triggers a payment charge.
 * Limits to 5 requests per minute per IP.
 *
 * Usage:
 *   @PaymentThrottle()
 *   @Post('retry/:invoiceId')
 *   async retryPayment(...) {}
 */

export const PaymentThrottle = (): MethodDecorator => 
  Throttle({
    payment: {
      ttl: THROTTLE_DEFAULTS.PAYMENT.ttl,
      limit: THROTTLE_DEFAULTS.PAYMENT.limit,
    },
  });
/**
 * Apply to health checks, monitoring endpoints — skip all throttling.
 * k8s probes hitting /health/live 10x/sec should never be rate limited.
 *
 * Usage:
 *   @SkipThrottling()
 *   @Get('live')
 *   getLiveness() {}
 */
export { SkipThrottle as SkipThrottling };

/**
 * Standard API tier — overrides global defaults with explicit values.
 * Use on endpoints that need custom limits different from global.
 *
 * Usage:
 *   @StandardThrottle()
 *   @Get('expensive-report')
 *   getReport() {}
 */
export const StandardThrottle = (): MethodDecorator =>
  Throttle({
    short:   { ttl: THROTTLE_DEFAULTS.SHORT.ttl,   limit: THROTTLE_DEFAULTS.SHORT.limit   },
    medium:  { ttl: THROTTLE_DEFAULTS.MEDIUM.ttl,  limit: THROTTLE_DEFAULTS.MEDIUM.limit  },
    long:    { ttl: THROTTLE_DEFAULTS.LONG.ttl,    limit: THROTTLE_DEFAULTS.LONG.limit    },
  });