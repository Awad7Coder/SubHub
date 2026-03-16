import  request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { createTestApp, clearDatabase, TestApp } from './setup/test-app.factory';
import { seedBaseData, SeedData } from './setup/seed.helpers';
import { Subscription } from '../../src/modules/subscriptions/entity/subscription.entity';
import { Invoice } from '../../src/modules/invoice/entity/invoice.entity';
import { Payment } from '../../src/modules/payments/entity/payment.entity';
import { SubscriptionStatus } from '../../src/modules/subscriptions/subscription.enum';
import { InvoiceStatus } from '../../src/modules/invoice/invoice.enum';
import { SubscriptionService } from '../../src/modules/subscriptions/subscriptions.service';
import { BillingService } from '../../src/modules/billing/billing.service';
import { getQueueToken } from '@nestjs/bullmq';
import { BILLING_JOBS } from '../../src/modules/subscriptions/subscription.enum';
import { BillingProcessor } from 'src/modules/billing/Billing.processor';

// --- Helpers ---
const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

async function waitForSubscriptionStatus(
  repo: Repository<Subscription>,
  id: string,
  expectedStatus: SubscriptionStatus,
) {
  for (let i = 0; i < 10; i++) {
    const sub = await repo.findOne({ where: { id } });
    if (sub?.status === expectedStatus) return sub;
    await delay(200);
  }
  const lastSub = await repo.findOne({ where: { id } });
  throw new Error(
    `Timed out: Expected ${expectedStatus}, but subscription ${id} is still ${lastSub?.status}`,
  );
}


describe('Subscription Flow (Integration)', () => {
  let testApp: TestApp;
  let app: INestApplication;
  let seed: SeedData;
  let subscriptionRepo: Repository<Subscription>;
  let invoiceRepo: Repository<Invoice>;
  let paymentRepo: Repository<Payment>;

  beforeAll(async () => {
    try {
      testApp = await createTestApp();
      app = testApp.app;
      subscriptionRepo = app.get(getRepositoryToken(Subscription));
      invoiceRepo = app.get(getRepositoryToken(Invoice));
      paymentRepo = app.get(getRepositoryToken(Payment));
    } catch (error) {
      console.error('❌ createTestApp() failed:', error.message);
      console.error(error.stack);
      throw error;
    }
  });

  afterAll(async () => {
    if (!app) return;
    await app.close();
  });

beforeEach(async () => {
  // Pause worker BEFORE clearing DB — prevents ghost jobs
  const billingQueue = app.get(getQueueToken(BILLING_JOBS.CHARGE_INVOICE));
  await billingQueue.pause();

  const billingProcessor = app.get(BillingProcessor);
  if (billingProcessor?.worker) {
    await billingProcessor.worker.pause();
  }

  await clearDatabase(app);
  seed = await seedBaseData(app);
  testApp.mockProvider.reset();
});

  // ── Critical Path 1: Happy Path ──────────────────────────────────────────

  describe('POST /api/subscriptions — payment succeeds', () => {
    it('creates subscription in PENDING state and queues charge', async () => {
      const idempotencyKey = uuidv4();

      const response = await request(app.getHttpServer())
        .post('/api/subscriptions')
        .set('Idempotency-Key', idempotencyKey)
        .send({
          customerId: seed.customer.id,
          planId: seed.activePlan.id,
        })
        .expect(201);

      expect(response.body.subscription!.status).toBe(SubscriptionStatus.PENDING);
      expect(response.body.invoiceId).toBeDefined();

      // Subscription exists in DB
      const subscription = await subscriptionRepo.findOne({
        where: { id: response.body.subscription!.id },
      });
      expect(subscription).toBeDefined();
      expect(subscription!.status).toBe(SubscriptionStatus.PENDING);

      // Invoice was created as OPEN
      const invoice = await invoiceRepo.findOne({
        where: { id: response.body.invoiceId },
      });
      expect(invoice!.status).toBe(InvoiceStatus.OPEN);
      expect(Number(invoice!.amount)).toBe(99.00);
    });

    it('transitions subscription to ACTIVE after successful charge', async () => {
      /**
       * WHY manually call attemptCharge instead of waiting for BullMQ?
       * In integration tests we don't run a real BullMQ worker.
       * The job gets queued but never processed automatically.
       * We call the service method directly to simulate what the worker does.
       * This tests the BUSINESS LOGIC of the charge, not the queue infrastructure.
       */
      testApp.mockProvider.shouldDecline = false; // Explicit: this test expects success
      const subscriptionService = app.get(SubscriptionService);
      const billingService = app.get(BillingService);

      const { subscription, invoiceId } = await subscriptionService.subscribe({
        customerId: seed.customer.id,
        planId: seed.activePlan.id,
      });

      // Simulate worker processing the charge job
      await billingService.attemptCharge(invoiceId, 1);

      // Invoice should now be PAID
      const invoice = await invoiceRepo.findOne({ where: { id: invoiceId } });
      expect(invoice!.status).toBe(InvoiceStatus.PAID);

      // Payment record should exist
      const payment = await paymentRepo.findOne({
        where: { invoice_id: invoiceId },
      });
      expect(payment).toBeDefined();
      expect(payment!.status).toBe('succeeded');
      expect(payment!.external_transaction_id).toMatch(/^mock_tx_/);

      // Subscription should now be ACTIVE
      const updatedSub = await subscriptionRepo.findOne({
        where: { id: subscription!.id },
      });
      expect(updatedSub!.status).toBe(SubscriptionStatus.ACTIVE);
    });
  });

  // ── Critical Path 2: Payment Failure → Retry ─────────────────────────────

  describe('Payment failure handling', () => {
    it('schedules retry when payment is declined on attempt 1', async () => {
      testApp.mockProvider.shouldDecline = true;

      const subscriptionService = app.get(SubscriptionService);
      const billingService = app.get(BillingService);

      const { invoiceId } = await subscriptionService.subscribe({
        customerId: seed.customer.id,
        planId: seed.activePlan.id,
      });

      // attemptCharge should NOT throw — it handles failure internally
      await expect(
        billingService.attemptCharge(invoiceId, 1),
      ).resolves.not.toThrow();

      // Invoice should still be OPEN (not yet uncollectible — more retries remain)
      const invoice = await invoiceRepo.findOne({ where: { id: invoiceId } });
      expect(invoice!.status).toBe(InvoiceStatus.OPEN);

      // Verify a retry job was queued (check BullMQ)
      const billingQueue = app.get(getQueueToken(BILLING_JOBS.CHARGE_INVOICE));
      const delayed = await billingQueue.getDelayed();
      expect(delayed.length).toBeGreaterThan(0);
      expect(delayed[0].name).toBe('retry_charge');
      expect(delayed[0].data.invoiceId).toBe(invoiceId);
      expect(delayed[0].data.attemptNumber).toBe(2);
    });

    it('marks invoice UNCOLLECTIBLE and subscription PAST_DUE after max retries', async () => {
      testApp.mockProvider.shouldDecline = true;

      const subscriptionService = app.get(SubscriptionService);
      const billingService = app.get(BillingService);

      const { subscription, invoiceId } = await subscriptionService.subscribe({
        customerId: seed.customer.id,
        planId: seed.activePlan.id,
      });

      // Simulate all 4 retry attempts exhausted
      // Attempt 1
      await billingService.attemptCharge(invoiceId, 1);
      // Attempt 2
      await billingService.attemptCharge(invoiceId, 2);
      // Attempt 3
      await billingService.attemptCharge(invoiceId, 3);
      // Attempt 4 — final
      await billingService.attemptCharge(invoiceId, 4);

      // Invoice should be UNCOLLECTIBLE
      const invoice = await invoiceRepo.findOne({ where: { id: invoiceId } });
      expect(invoice!.status).toBe(InvoiceStatus.UNCOLLECTIBLE);

      // Subscription should be PAST_DUE (not cancelled — customer can still recover)
      const sub = await subscriptionRepo.findOne({
        where: { id: subscription!.id },
      });
      expect(sub!.status).toBe(SubscriptionStatus.PAST_DUE);
    });
  });

  // ── Critical Path 3: Cancel Flow ─────────────────────────────────────────

  describe('Cancellation', () => {
    it('soft cancel — sets cancel_at_period_end, preserves access', async () => {
      const subscriptionService = app.get(SubscriptionService);
      const billingService = app.get(BillingService);

      const { subscription, invoiceId } = await subscriptionService.subscribe({
        customerId: seed.customer.id,
        planId: seed.activePlan.id,
      });

      // Activate it first
      await billingService.attemptCharge(invoiceId, 1);

      // Soft cancel
      const idempotencyKey = uuidv4();
      await request(app.getHttpServer())
        .delete(`/api/subscriptions/${subscription!.id}`)
        .set('Idempotency-Key', idempotencyKey)
        .expect(200);

      const updated = await subscriptionRepo.findOne({
        where: { id: subscription!.id },
      });

      // Status still ACTIVE — customer keeps access until period ends
      expect(updated!.status).toBe(SubscriptionStatus.ACTIVE);
      // But the flag is set — renewal scheduler will cancel instead of renew
      expect(updated!.cancel_at_period_end).toBe(true);
    });

    it('renew() cancels instead of charging when cancel_at_period_end is set', async () => {
      const subscriptionService = app.get(SubscriptionService);
      const billingService = app.get(BillingService);

      const { subscription, invoiceId } = await subscriptionService.subscribe({
        customerId: seed.customer.id,
        planId: seed.activePlan.id,
      });

      await billingService.attemptCharge(invoiceId, 1);
      await subscriptionService.cancel(subscription!.id);

      // Simulate the scheduler calling renew() at period end
      await subscriptionService.renew(subscription!.id);

      const updated = await subscriptionRepo.findOne({
        where: { id: subscription!.id },
      });

      // Should be CANCELLED — no new invoice, no new charge
      expect(updated!.status).toBe(SubscriptionStatus.CANCELLED);

      // Only the original invoice should exist — no renewal invoice
      const invoices = await invoiceRepo.find({
        where: { subscription_id: subscription!.id },
      });
      expect(invoices).toHaveLength(1);
    });
  });

  // ── Critical Path 4: Guard Failures ──────────────────────────────────────

  describe('Input validation', () => {
    it('returns 400 when Idempotency-Key header is missing', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/subscriptions')
        .send({
          customerId: seed.customer.id,
          planId: seed.activePlan.id,
        })
        .expect(400);

      expect(response.body.code).toBe('IDEMPOTENCY_KEY_MISSING');
      expect(response.body.message).toContain('Idempotency-Key');
    });

    it('returns 404 when customer does not exist', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/subscriptions')
        .set('Idempotency-Key', uuidv4())
        .send({
          customerId: uuidv4(), // non-existent
          planId: seed.activePlan.id,
        })
        .expect(404);

      expect(response.body.code).toBe('CUSTOMER_NOT_FOUND');
    });

    it('returns 409 when customer already has an active subscription', async () => {
      const subscriptionService = app.get(SubscriptionService);
      const billingService = app.get(BillingService);

      // Create and activate first subscription
      const { invoiceId } = await subscriptionService.subscribe({
        customerId: seed.customer.id,
        planId: seed.activePlan.id,
      });
      await billingService.attemptCharge(invoiceId, 1);

      // Try to subscribe again
      const response = await request(app.getHttpServer())
        .post('/api/subscriptions')
        .set('Idempotency-Key', uuidv4())
        .send({
          customerId: seed.customer.id,
          planId: seed.activePlan.id,
        })
        .expect(409);

      expect(response.body.code).toBe('DUPLICATE_SUBSCRIPTION');
    });

    it('returns 403 when plan is inactive', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/subscriptions')
        .set('Idempotency-Key', uuidv4())
        .send({
          customerId: seed.customer.id,
          planId: seed.inactivePlan.id,
        })
        .expect(403);

      expect(response.body.code).toBe('PLAN_INACTIVE');
    });
  });

  // ── Critical Path 5: Idempotency ─────────────────────────────────────────

  describe('Idempotency', () => {
    it('returns cached response on retry with same key — handler runs once', async () => {
      const idempotencyKey = uuidv4();
      let handlerCallCount = 0;

      // Spy on subscribe to count how many times it's called
      const subscriptionService = app.get(SubscriptionService);
      const originalSubscribe = subscriptionService.subscribe.bind(subscriptionService);
      subscriptionService.subscribe = async (...args: any[]) => {
        handlerCallCount++;
        return originalSubscribe(...args);
      };

      const payload = {
        customerId: seed.customer.id,
        planId: seed.activePlan.id,
      };

      // First request
      const first = await request(app.getHttpServer())
        .post('/api/subscriptions')
        .set('Idempotency-Key', idempotencyKey)
        .send(payload)
        .expect(201);

      // Second request — same key, same body
      const second = await request(app.getHttpServer())
        .post('/api/subscriptions')
        .set('Idempotency-Key', idempotencyKey)
        .send(payload)
        .expect(201);

      // Handler ran exactly once
      expect(handlerCallCount).toBe(1);

      // Responses are identical
      expect(second.body).toEqual(first.body);

      // Second response has the replay header
      expect(second.headers['x-idempotent-replayed']).toBe('true');

      // Only one subscription in the DB
      const subs = await subscriptionRepo.find({
        where: { customer_id: seed.customer.id },
      });
      expect(subs).toHaveLength(1);
    });

    it('returns 422 when same key is reused with different body', async () => {
      const idempotencyKey = uuidv4();

      // First request
      await request(app.getHttpServer())
        .post('/api/subscriptions')
        .set('Idempotency-Key', idempotencyKey)
        .send({
          customerId: seed.customer.id,
          planId: seed.activePlan.id,
        })
        .expect(201);

      // Second request — same key, DIFFERENT body
      const response = await request(app.getHttpServer())
        .post('/api/subscriptions')
        .set('Idempotency-Key', idempotencyKey)
        .send({
          customerId: seed.customer.id,
          planId: seed.inactivePlan.id, // different plan
        })
        .expect(422);

      expect(response.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });
  });
});
