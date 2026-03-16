import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: Add processed_webhook_events table
 *
 * WHY a dedicated table instead of reusing idempotency_keys?
 *
 * idempotency_keys is for CLIENT requests — keyed by Idempotency-Key header,
 * expires after 24h, stores the full response body for replay.
 *
 * processed_webhook_events is for STRIPE EVENTS — keyed by Stripe event ID,
 * never needs to expire (Stripe won't resend after 72h), stores no response body.
 *
 * Different shape, different TTL, different purpose. Mixing them would make
 * both tables harder to reason about and query efficiently.
 *
 * HOW TO RUN:
 *   npm run migration:run
 *
 * HOW TO REVERT:
 *   npm run migration:revert
 */
export class WebhookDeduplication1700000000001 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "processed_webhook_events" (
        "event_id"    VARCHAR(255)             NOT NULL,
        "event_type"  VARCHAR(100)             NOT NULL,
        "processed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),

        CONSTRAINT "PK_processed_webhook_events" PRIMARY KEY ("event_id")
      )
    `);

    /*
     * WHY index on processed_at?
     * For the cleanup job — DELETE WHERE processed_at < NOW() - INTERVAL '7 days'
     * Without this index, that query is a full table scan every night.
     */
    await queryRunner.query(`
      CREATE INDEX "IDX_processed_webhook_events_processed_at"
        ON "processed_webhook_events" ("processed_at")
    `);

    /*
     * WHY index on event_type?
     * Useful for monitoring queries:
     * "How many payment_intent.succeeded events did we process today?"
     * Also useful for debugging: find all events of a type in a time window.
     */
    await queryRunner.query(`
      CREATE INDEX "IDX_processed_webhook_events_event_type"
        ON "processed_webhook_events" ("event_type")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "processed_webhook_events"`);
  }
}