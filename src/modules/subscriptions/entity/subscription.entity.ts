import { Plan } from 'src/modules/plan/entity/plan.entity';
import { Customer } from 'src/modules/customers/entity/customer.entity';
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index
} from 'typeorm';


@Entity('subscriptions')
@Index(['customer_id'])
@Index(['plan_id'])
export class Subscription {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Customer, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'customer_id' })
  customer: Customer;

  @Column({ type: 'uuid' })
  customer_id: string;

  @ManyToOne(() => Plan, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'plan_id' })
  plan: Plan;

  @Column({ type: 'uuid' })
  plan_id: string;

  @Column({ default: 'active' })
  status: string;

  @Column({ type: 'timestamptz' })
  current_period_start: Date;

  @Column({ type: 'timestamptz' })
  current_period_end: Date;

  @Column({ default: false })
  cancel_at_period_end: boolean;

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, any>;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}