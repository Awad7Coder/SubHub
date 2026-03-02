import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  Index,
} from 'typeorm';
import { Subscription } from '../../subscriptions/entity/subscription.entity';

@Entity('usage_logs')
@Index(['subscription_id'])
@Index(['subscription_id', 'action_type'])
export class UsageLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Subscription, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'subscription_id' })
  subscription: Subscription;

  @Column({ type: 'uuid' })
  subscription_id: string;

  @Column({ type: 'integer', default: 1 })
  amount_used: number;

  @Column({ type: 'varchar', length: 100 })
  action_type: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, any>;

  @CreateDateColumn({ type: 'timestamptz' })
  recorded_at: Date;
}
