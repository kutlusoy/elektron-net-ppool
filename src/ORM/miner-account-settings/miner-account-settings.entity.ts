import { Column, Entity, PrimaryColumn } from 'typeorm';

import { TrackedEntity } from '../utils/TrackedEntity.entity';

// Phase 2 (concept doc §11): per-miner account preferences, unlocked only
// after proving address ownership via signed-message login (see AuthService).
// One row per miner address, created lazily on first settings write.
@Entity()
export class MinerAccountSettingsEntity extends TrackedEntity {

    @PrimaryColumn({ length: 62, type: 'varchar' })
    address: string;

    // Overrides the pool-wide MIN_PAYOUT_THRESHOLD_SATS for this miner only.
    // null means "use the pool default".
    @Column({ type: 'bigint', nullable: true })
    payoutThresholdSatsOverride: number | null;

    // Sends a Telegram message (via the miner's existing /subscribe chat, see
    // TelegramSubscriptionsService) whenever a payout batch including this
    // miner is sent -- separate from the pool-wide block-found notification.
    @Column({ type: 'boolean', default: false })
    notifyOnPayout: boolean;

}
