import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createHash } from 'crypto';
import { Idempotency } from './entity/idempotency.entity';


// ─── Types ─────────────────────────────────────────────────────────────────

export interface CachedResponse {
  statusCode: number;
  body: unknown;
}

export interface IdempotencyCheckResult {
  /**
   * found:        key exists in DB
   * hashMatch:    the stored request_hash matches the incoming request
   * cached:       the response to return (only present when found + hashMatch)
   */
  found: boolean;
  hashMatch: boolean;
  cached?: CachedResponse;
}

// ─── Constants ─────────────────────────────────────────────────────────────

/**
 * WHY 24 hours for expiry?
 * Stripe uses 24 hours as their idempotency window.
 * It's long enough that any legitimate retry (network blip, client timeout)
 * will be deduplicated. It's short enough that the table doesn't grow forever
 * — the nightly cleanup job handles the rest.
 *
 * In practice: a client retrying a failed payment 25 hours later is a
 * deliberate re-attempt, not an accidental duplicate. Let it through.
 */
const IDEMPOTENCY_TTL_HOURS = 24;

// ─── Service ───────────────────────────────────────────────────────────────

@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(
    @InjectRepository(Idempotency)
    private readonly idempotencyRepo: Repository<Idempotency>,
  ) {}

  // ─── Hash the Request ─────────────────────────────────────────────────

  /**
   * Produces a deterministic fingerprint of the request body.
   *
   * WHY SHA-256 and not just JSON.stringify comparison?
   * Two reasons:
   * 1. Size: storing SHA-256 (64 chars) vs storing the full request body
   *    (potentially kilobytes) keeps the DB row small and the index fast.
   * 2. Determinism: JSON.stringify({ a:1, b:2 }) and JSON.stringify({ b:2, a:1 })
   *    produce different strings for the same data. We sort keys before
   *    hashing to ensure key order doesn't create false mismatches.
   *
   * WHY not MD5? SHA-256 is collision-resistant. MD5 is not.
   * For security-adjacent code (preventing double charges), use SHA-256.
   */
  hashRequest(body: unknown): string {
    const normalized = JSON.stringify(body, Object.keys(body as object).sort());
    return createHash('sha256').update(normalized).digest('hex');
  }

  // ─── Check Existing Key ───────────────────────────────────────────────

  /**
   * Looks up an idempotency key and evaluates whether it's a valid replay.
   *
   * Three possible outcomes:
   * 1. Not found     → first time seeing this key, proceed normally
   * 2. Found, hash matches   → legitimate retry, return cached response
   * 3. Found, hash differs   → client reused key with different body → 422
   */
  async check(
    key: string,
    requestHash: string,
  ): Promise<IdempotencyCheckResult> {
    const existing = await this.idempotencyRepo.findOne({
      where: { key },
    });

    if (!existing) {
      return { found: false, hashMatch: false };
    }

    /**
     * WHY also check expiry here even though the cleanup job runs nightly?
     * The cleanup job runs at 2am. An expired key at 10pm hasn't been
     * deleted yet. Without this check, a key from yesterday would still
     * block legitimate new requests.
     *
     * Defense in depth: DB cleanup removes the rows eventually.
     * Application check ensures expired keys are treated as missing NOW.
     */
    if (existing.expires_at < new Date()) {
      this.logger.debug(`Idempotency key ${key} found but expired — treating as new`);
      return { found: false, hashMatch: false };
    }

    const hashMatch = existing.request_hash === requestHash;

    if (!hashMatch) {
      this.logger.warn(
        `Idempotency key ${key} reused with different request body — potential client bug`,
      );
      return { found: true, hashMatch: false };
    }

    this.logger.log(`Idempotency key ${key} matched — returning cached response`);

    return {
      found: true,
      hashMatch: true,
      cached: {
        statusCode: existing.status_code,
        body: existing.response_body,
      },
    };
  }

  // ─── Store Response ───────────────────────────────────────────────────

  /**
   * Caches the response after the controller successfully runs.
   *
   * WHY upsert instead of insert?
   * Race condition: two identical requests arrive simultaneously (milliseconds apart).
   * Both pass the check() above (neither is in DB yet).
   * Both hit the controller. Both try to insert the same key.
   * Second insert would throw a unique constraint violation.
   *
   * Upsert (INSERT ... ON CONFLICT DO UPDATE) handles this atomically:
   * whichever request wins the race inserts the row.
   * The loser updates it — which is fine because both requests had the
   * same body (same hash) so the cached response is identical either way.
   *
   * WHY store even error responses?
   * If the controller returns a 400 (validation error), we still cache it.
   * The client retrying with the same bad body should get the same 400 back,
   * not re-run validation and potentially get a different error message.
   * Consistency matters more than re-validating.
   */
  async store(
    key: string,
    requestHash: string,
    statusCode: number,
    responseBody: unknown,
  ): Promise<void> {
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + IDEMPOTENCY_TTL_HOURS);

    await this.idempotencyRepo
      .createQueryBuilder()
      .insert()
      .into(Idempotency)
      .values({
        key,
        request_hash: requestHash,
        status_code: statusCode,
        response_body: responseBody as any,
        expires_at: expiresAt,
      })
      .orUpdate(
        /**
         * WHY update these specific columns on conflict?
         * key is the conflict target (primary key) — don't update it.
         * request_hash: update to latest (same value in a valid race)
         * status_code + response_body: the actual cached response
         * updated_at: let TypeORM handle via @UpdateDateColumn
         * expires_at: refresh the TTL window on each store
         */
        ['request_hash', 'status_code', 'response_body', 'expires_at'],
        ['key'],
      )
      .execute();

    this.logger.debug(
      `Idempotency key ${key} stored — status: ${statusCode}, expires: ${expiresAt.toISOString()}`,
    );
  }
}