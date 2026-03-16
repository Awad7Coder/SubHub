import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

/**
 * WHY PrimaryColumn (string) instead of the usual UUID PrimaryGeneratedColumn?
 *
 * The event_id IS the primary key — it's Stripe's globally unique event ID
 * (e.g. evt_1Abc123...). Using it as PK gives us deduplication for free:
 * INSERT on a duplicate event_id fails with a unique constraint violation,
 * which we catch and treat as "already processed."
 *
 * A separate auto-generated UUID would add complexity with no benefit here.
 */
@Entity('processed_webhook_events')
export class ProcessedWebhookEvent {
  @PrimaryColumn({ type: 'varchar', length: 255 })
  event_id: string;

  @Column({ type: 'varchar', length: 100 })
  event_type: string;

  @CreateDateColumn({ type: 'timestamptz' })
  processed_at: Date;
}