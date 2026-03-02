import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";

@Entity('customers')
export class Customer {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ unique: true })
    email: string;

    @Column({ nullable: true })
    full_name?: string;

    @Index()
    @Column({ nullable: true })
    external_id?: string;

    @Column({ default: 'manual' })
    payment_provider: string;

    @Column({ default: true })
    is_active: boolean;

    @Column({ type: 'jsonb', nullable: true })
    metadata?: Record<string, any>;

    @CreateDateColumn({ type: 'timestamptz' })
    created_at: Date;

    @UpdateDateColumn({ type: 'timestamptz' })
    updated_at: Date;
}