import {
  Column,
  Entity,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn
} from "typeorm";

const decimalToNumber = {
  to: (value: number) => value,
  from: (value: string) => (value === null ? null : parseFloat(value)),
};

@Entity('plans')
export class Plan {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ type: 'decimal', precision: 10, scale: 2, transformer: decimalToNumber })
  price: number;

  @Column({ default: 'USD' })
  currency: string;

  @Column({ type: 'interval' })
  interval: string;

  @Column({ default: 30 })
  duration_days: number;

  @Column({ default: 0 })
  usage_limit: number;

  @Column({ default: true })
  is_active: boolean;

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, any>;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}