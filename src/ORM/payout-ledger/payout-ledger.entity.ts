import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

import { TrackedEntity } from '../utils/TrackedEntity.entity';

export enum ePayoutStatus {
    PENDING = 'PENDING',
    SENT = 'SENT',
    CONFIRMED = 'CONFIRMED',
}

// One row per PPLNS reward credit (concept doc §5.3/§5.4/§10.3). A row starts
// PENDING when RewardCalculatorService credits a miner for a found block; it
// becomes SENT once PayoutSchedulerService includes it in a batch
// transaction, and CONFIRMED once that transaction has enough confirmations.
// This single ledger doubles as both the "pending balance" aggregate (SUM of
// PENDING rows) and the payout-history endpoint (SENT/CONFIRMED rows),
// avoiding a separate running-balance table that could drift from the
// underlying per-block credits.
@Entity()
@Index(['minerAddress', 'status'])
@Index(['txid'])
export class PayoutLedgerEntity extends TrackedEntity {

    @PrimaryGeneratedColumn()
    id: number;

    @Column({ length: 62, type: 'varchar' })
    minerAddress: string;

    @Column({ type: 'integer' })
    blockHeight: number;

    @Column({ type: 'bigint' })
    amountSats: number;

    @Column({ type: 'varchar', length: 20, default: ePayoutStatus.PENDING })
    status: ePayoutStatus;

    @Column({ type: 'varchar', length: 64, nullable: true })
    txid: string | null;

}
