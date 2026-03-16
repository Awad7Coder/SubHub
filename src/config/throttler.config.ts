// src/config/throttler.config.ts
import { registerAs } from '@nestjs/config';

export interface ThrottleTier {
  ttl: number;
  limit: number;
}

// 2. Export a plain object that decorators can use
export const THROTTLE_DEFAULTS = {
  SHORT: { ttl: 1000, limit: 100 },
  MEDIUM: { ttl: 60000, limit: 300 },
  LONG: { ttl: 3600000, limit: 1000 },
  PAYMENT: { ttl: 60000, limit: 5 },
};

export default registerAs('throttle', () => ({
  short: {
    ttl: parseInt(process.env.THROTTLE_SHORT_TTL ?? '1000', 10),
    limit: parseInt(process.env.THROTTLE_SHORT_LIMIT ?? '100', 10),
  },
  medium: {
    ttl: parseInt(process.env.THROTTLE_MEDIUM_TTL ?? '60000', 10),
    limit: parseInt(process.env.THROTTLE_MEDIUM_LIMIT ?? '300', 10),
  },
  long: {
    ttl: parseInt(process.env.THROTTLE_LONG_TTL ?? '3600000', 10),
    limit: parseInt(process.env.THROTTLE_LONG_LIMIT ?? '1000', 10),
  },
  payment: {
    ttl: parseInt(process.env.THROTTLE_PAYMENT_TTL ?? '60000', 10),
    limit: parseInt(process.env.THROTTLE_PAYMENT_LIMIT ?? '5', 10),
  },
}));