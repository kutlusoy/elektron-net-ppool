import { Column, Entity, PrimaryColumn } from 'typeorm';

// Singleton row (id=1). Concept doc §5.3: integer-satoshi rounding produces
// minor "dust" remainders on every PPLNS split; these are tracked here
// instead of silently discarded, for transparency towards miners. The pool
// fee itself (§5.5 POOL_FEE_PERCENT) is also accumulated here so it can be
// disclosed via the fee-info endpoint's companion accounting view.
@Entity()
export class PoolAccountingEntity {

    @PrimaryColumn({ default: 1 })
    id: number;

    @Column({ type: 'bigint', default: 0 })
    totalFeeSats: number;

    @Column({ type: 'bigint', default: 0 })
    totalDustSats: number;

}
