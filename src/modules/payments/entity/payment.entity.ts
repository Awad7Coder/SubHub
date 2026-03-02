import { Invoice } from "src/modules/invoice/entity/invoice.entity";
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  Index
} from "typeorm";

@Entity('payments')
@Index(['external_transaction_id'], { unique: true })
export class Payment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Invoice, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'invoice_id' })
  invoice: Invoice;

  @Column({ type: 'uuid' })
  invoice_id: string;

  @Column({
    type: 'decimal', precision: 10, scale: 2, transformer: {
      to: (value: number) => value,
      from: (value: string) => (value === null ? null : parseFloat(value)),
    }
  })
  amount: number;

  @Column()
  provider: string;

  @Column({ unique: true })
  external_transaction_id: string;

  @Column()
  status: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}