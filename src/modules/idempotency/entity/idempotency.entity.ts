import {
    Entity,
    PrimaryColumn,
    Column,
    CreateDateColumn,
    Index,
    UpdateDateColumn
} from 'typeorm';

@Entity('idempotency_keys')
@Index(['key', 'request_hash'], { unique: true })
export class Idempotency {
    @PrimaryColumn({ type: 'varchar', length: 512 })
    key: string;

    @Column({ type: 'text' })
    request_hash: string;

    @Column({ type: 'smallint' })
    status_code: number;

    @Column({ type: 'jsonb' })
    response_body: unknown;

    @CreateDateColumn({ type: 'timestamptz' })
    created_at: Date;

    @UpdateDateColumn({ type: 'timestamptz' })
    updated_at: Date;

    @Index()
    @Column({ type: 'timestamptz' })
    expires_at: Date;
}
