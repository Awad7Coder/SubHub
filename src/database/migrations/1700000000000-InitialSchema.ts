import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * MIGRATION NAMING CONVENTION: {timestamp}_{PascalCaseDescription}
 *
 * WHY timestamp prefix?
 * TypeORM runs migrations in filename order. The timestamp guarantees
 * chronological execution regardless of alphabetical order.
 * Never rename migration files after they've been run — the
 * typeorm_migrations table records the filename as the identifier.
 *
 * HOW TO GENERATE future migrations:
 *   npm run migration:generate -- src/database/migrations/AddColumnToSubscriptions
 *
 * TypeORM will diff your current entities against the DB and generate
 * the SQL automatically. Review the generated file before running it.
 *
 * HOW TO RUN:
 *   npm run migration:run
 *
 * HOW TO REVERT (rolls back the most recent migration):
 *   npm run migration:revert
 */
export class InitialSchema1700000000000 implements MigrationInterface {
  name = 'InitialSchema1700000000000';

  // ── up() — apply the migration ──────────────────────────────────────────

  public async up(queryRunner: QueryRunner): Promise<void> {

    // ── 0. Extensions ──────────────────────────────────────────────────────

    /**
     * WHY uuid-ossp extension?
     * Enables gen_random_uuid() which PostgreSQL uses to auto-generate
     * UUID primary keys. Without this, DEFAULT gen_random_uuid() fails.
     *
     * WHY IF NOT EXISTS?
     * Makes the migration idempotent — safe to run on a DB that already
     * has the extension installed (e.g. a restored backup).
     */
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

    // ── 1. Customers ───────────────────────────────────────────────────────

    await queryRunner.query(`
      CREATE TABLE "customers" (
        "id"               UUID                NOT NULL DEFAULT gen_random_uuid(),
        "email"            VARCHAR(255)         NOT NULL,
        "full_name"        VARCHAR(255)         NOT NULL,
        "is_active"        BOOLEAN             NOT NULL DEFAULT true,
        "payment_provider" VARCHAR(50)          NOT NULL DEFAULT 'stripe',
        "metadata"         JSONB,
        "created_at"       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at"       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_customers" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_customers_email" UNIQUE ("email")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_customers_email" ON "customers" ("email")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_customers_is_active" ON "customers" ("is_active")
        WHERE "is_active" = true
    `);

    // ── 2. Plans ───────────────────────────────────────────────────────────

    await queryRunner.query(`
      CREATE TABLE "plans" (
        "id"          UUID                     NOT NULL DEFAULT gen_random_uuid(),
        "name"        VARCHAR(255)             NOT NULL,
        "price"       NUMERIC(10, 2)           NOT NULL,
        "currency"    VARCHAR(3)               NOT NULL DEFAULT 'usd',
        "interval"    VARCHAR(50)              NOT NULL,
        "usage_limit" INTEGER                  NOT NULL DEFAULT 0,
        "is_active"   BOOLEAN                  NOT NULL DEFAULT true,
        "metadata"    JSONB,
        "created_at"  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at"  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_plans" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_plans_is_active" ON "plans" ("is_active")
        WHERE "is_active" = true
    `);

    // ── 3. Subscriptions ───────────────────────────────────────────────────

    await queryRunner.query(`
      CREATE TYPE "subscription_status_enum" AS ENUM (
        'pending',
        'active',
        'past_due',
        'cancelled'
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "subscriptions" (
        "id"                   UUID                        NOT NULL DEFAULT gen_random_uuid(),
        "customer_id"          UUID                        NOT NULL,
        "plan_id"              UUID                        NOT NULL,
        "status"               "subscription_status_enum"  NOT NULL DEFAULT 'pending',
        "current_period_start" TIMESTAMP WITH TIME ZONE    NOT NULL,
        "current_period_end"   TIMESTAMP WITH TIME ZONE    NOT NULL,
        "cancel_at_period_end" BOOLEAN                     NOT NULL DEFAULT false,
        "metadata"             JSONB,
        "created_at"           TIMESTAMP WITH TIME ZONE    NOT NULL DEFAULT now(),
        "updated_at"           TIMESTAMP WITH TIME ZONE    NOT NULL DEFAULT now(),
        CONSTRAINT "PK_subscriptions" PRIMARY KEY ("id"),
        CONSTRAINT "FK_subscriptions_customer"
          FOREIGN KEY ("customer_id") REFERENCES "customers"("id")
          ON DELETE RESTRICT,
        CONSTRAINT "FK_subscriptions_plan"
          FOREIGN KEY ("plan_id") REFERENCES "plans"("id")
          ON DELETE RESTRICT
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_subscriptions_customer_id"
        ON "subscriptions" ("customer_id")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_subscriptions_status"
        ON "subscriptions" ("status")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_subscriptions_period_end"
        ON "subscriptions" ("current_period_end")
        WHERE "status" = 'active'
    `);

    /**
     * WHY a partial unique index instead of a regular unique constraint?
     * We want to enforce: one ACTIVE subscription per customer.
     * But a customer CAN have multiple cancelled subscriptions (historical).
     * A regular UNIQUE on (customer_id, status) would prevent that.
     * A partial unique index only applies to active rows — exactly the
     * business rule we need.
     */
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_subscriptions_one_active_per_customer"
        ON "subscriptions" ("customer_id")
        WHERE "status" = 'active'
    `);

    // ── 4. Invoices ────────────────────────────────────────────────────────

    await queryRunner.query(`
      CREATE TYPE "invoice_status_enum" AS ENUM (
        'open',
        'paid',
        'void',
        'uncollectible'
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "invoices" (
        "id"              UUID                     NOT NULL DEFAULT gen_random_uuid(),
        "subscription_id" UUID,
        "customer_id"     UUID                     NOT NULL,
        "amount"          NUMERIC(10, 2)           NOT NULL,
        "currency"        VARCHAR(3)               NOT NULL DEFAULT 'usd',
        "status"          "invoice_status_enum"    NOT NULL DEFAULT 'open',
        "metadata"        JSONB,
        "created_at"      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at"      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_invoices" PRIMARY KEY ("id"),
        CONSTRAINT "FK_invoices_customer"
          FOREIGN KEY ("customer_id") REFERENCES "customers"("id")
          ON DELETE RESTRICT,
        CONSTRAINT "FK_invoices_subscription"
          FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id")
          ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_invoices_customer_id"
        ON "invoices" ("customer_id")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_invoices_subscription_id"
        ON "invoices" ("subscription_id")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_invoices_status"
        ON "invoices" ("status")
        WHERE "status" = 'open'
    `);

    // ── 5. Payments ────────────────────────────────────────────────────────

    await queryRunner.query(`
      CREATE TYPE "payment_status_enum" AS ENUM (
        'pending',
        'succeeded',
        'failed',
        'refunded'
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "payments" (
        "id"                     UUID                     NOT NULL DEFAULT gen_random_uuid(),
        "invoice_id"             UUID                     NOT NULL,
        "amount"                 NUMERIC(10, 2)           NOT NULL,
        "provider"               VARCHAR(50)              NOT NULL DEFAULT 'stripe',
        "external_transaction_id" VARCHAR(255),
        "status"                 "payment_status_enum"    NOT NULL DEFAULT 'pending',
        "metadata"               JSONB,
        "created_at"             TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at"             TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_payments" PRIMARY KEY ("id"),
        CONSTRAINT "FK_payments_invoice"
          FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id")
          ON DELETE RESTRICT,
        CONSTRAINT "UQ_payments_external_transaction_id"
          UNIQUE ("external_transaction_id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_payments_invoice_id"
        ON "payments" ("invoice_id")
    `);

    // ── 6. Usage Logs ──────────────────────────────────────────────────────

    await queryRunner.query(`
      CREATE TABLE "usage_logs" (
        "id"              UUID                     NOT NULL DEFAULT gen_random_uuid(),
        "subscription_id" UUID                     NOT NULL,
        "action_type"     VARCHAR(100)             NOT NULL,
        "amount_used"     INTEGER                  NOT NULL DEFAULT 1,
        "metadata"        JSONB,
        "recorded_at"     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_usage_logs" PRIMARY KEY ("id"),
        CONSTRAINT "FK_usage_logs_subscription"
          FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id")
          ON DELETE CASCADE
      )
    `);

    /**
     * WHY composite index on (subscription_id, action_type, recorded_at)?
     * The most common query: "how many api_call events did subscription X
     * have since period start?" This index serves that query in one
     * B-tree traversal — no table scan needed.
     */
    await queryRunner.query(`
      CREATE INDEX "IDX_usage_logs_subscription_action_time"
        ON "usage_logs" ("subscription_id", "action_type", "recorded_at")
    `);

    // ── 7. Idempotency Keys ────────────────────────────────────────────────

    await queryRunner.query(`
      CREATE TABLE "idempotency_keys" (
        "key"           VARCHAR(512)             NOT NULL,
        "request_hash"  VARCHAR(64)              NOT NULL,
        "status_code"   INTEGER                  NOT NULL,
        "response_body" JSONB                    NOT NULL,
        "expires_at"    TIMESTAMP WITH TIME ZONE NOT NULL,
        "created_at"    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at"    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_idempotency_keys" PRIMARY KEY ("key")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_idempotency_keys_expires_at"
        ON "idempotency_keys" ("expires_at")
    `);
  }

  // ── down() — revert the migration ──────────────────────────────────────

  /**
   * WHY implement down()?
   * If a migration is deployed and causes problems, `npm run migration:revert`
   * calls down() to roll back to the previous state.
   *
   * WHY drop in reverse order?
   * Foreign key constraints. Dropping "subscriptions" before "invoices"
   * would fail because invoices.subscription_id references subscriptions.id.
   * Always drop child tables before parent tables.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "idempotency_keys"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "usage_logs"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "payments"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "payment_status_enum"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "invoices"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "invoice_status_enum"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "subscriptions"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "subscription_status_enum"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "plans"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "customers"`);
  }
}