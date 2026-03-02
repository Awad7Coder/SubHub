
import { Customer } from "src/modules/customers/entity/customer.entity";
import { Subscription } from "src/modules/subscriptions/entity/subscription.entity";
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  Index,
  UpdateDateColumn
} from "typeorm";

const decimalToNumber = {
  to: (value: number) => value,
  from: (value: string) => (value === null ? null : parseFloat(value)),
};

@Entity('invoices')
@Index(['customer_id'])
@Index(['subscription_id'])
export class Invoice {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Customer, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'customer_id' })
  customer: Customer;

  @Column({ type: 'uuid' })
  customer_id: string;

  @ManyToOne(() => Subscription, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'subscription_id' })
  subscription: Subscription;

  @Column({ type: 'uuid', nullable: true })
  subscription_id: string;

  @Column({ type: 'decimal', precision: 10, scale: 2, transformer: decimalToNumber })
  amount: number;

  @Column({ default: 'USD' })
  currency: string;

  @Column({ default: 'open' })
  status: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, any>;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}