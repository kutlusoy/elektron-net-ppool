import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

import { TrackedEntity } from '../utils/TrackedEntity.entity';

// Concept doc §5.1: fine-grained, timestamped record of every valid share for
// PPLNS window calculation. Independent of ClientStatisticsEntity, whose
// 10-minute buckets are too coarse for a 60s block time (a block found
// mid-bucket can't be cleanly attributed to a time window).
@Entity()
@Index(['timestamp'])
@Index(['minerAddress', 'timestamp'])
export class PplnsShareEntity extends TrackedEntity {

    @PrimaryGeneratedColumn()
    id: number;

    @Column({ length: 62, type: 'varchar' })
    minerAddress: string;

    @Column({ type: 'real' })
    difficulty: number;

    // Unix ms. Indexed separately from createdAt so window queries don't
    // depend on TypeORM's datetime transformer.
    @Column({ type: 'integer' })
    timestamp: number;

    // For traceability/debugging only — not used in the reward calculation.
    @Column({ type: 'integer' })
    blockHeightAtSubmission: number;

}
