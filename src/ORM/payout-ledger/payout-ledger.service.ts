import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ePayoutStatus, PayoutLedgerEntity } from './payout-ledger.entity';

export interface IPendingPayoutCandidate {
    minerAddress: string;
    totalPendingSats: number;
    maxRowId: number;
}

@Injectable()
export class PayoutLedgerService {

    constructor(
        @InjectRepository(PayoutLedgerEntity)
        private readonly payoutLedgerRepository: Repository<PayoutLedgerEntity>,
    ) {
    }

    public async credit(minerAddress: string, amountSats: number, blockHeight: number): Promise<void> {
        if (amountSats <= 0) {
            return;
        }
        await this.payoutLedgerRepository.insert({
            minerAddress,
            blockHeight,
            amountSats,
            status: ePayoutStatus.PENDING,
            txid: null,
        });
    }

    public async getPendingTotal(minerAddress: string): Promise<number> {
        const result = await this.payoutLedgerRepository
            .createQueryBuilder('ledger')
            .select('COALESCE(SUM(ledger.amountSats), 0)', 'total')
            .where('ledger.minerAddress = :minerAddress', { minerAddress })
            .andWhere('ledger.status = :status', { status: ePayoutStatus.PENDING })
            .getRawOne();
        return Number(result?.total ?? 0);
    }

    public async getTotalPendingAcrossAllMiners(): Promise<number> {
        const result = await this.payoutLedgerRepository
            .createQueryBuilder('ledger')
            .select('COALESCE(SUM(ledger.amountSats), 0)', 'total')
            .where('ledger.status = :status', { status: ePayoutStatus.PENDING })
            .getRawOne();
        return Number(result?.total ?? 0);
    }

    // Groups all PENDING rows by miner, keeping the highest row id per miner as
    // a stable cutoff so a batch payout only claims the rows that existed when
    // the cycle started — shares credited while the sendmany call is in flight
    // remain PENDING for the next cycle instead of being silently included.
    // Deliberately not threshold-filtered here: each miner may have their own
    // payout threshold override (concept doc §11), so PayoutSchedulerService
    // applies the effective per-miner threshold itself after fetching this.
    public async getAllPendingTotals(): Promise<IPendingPayoutCandidate[]> {
        const rows = await this.payoutLedgerRepository
            .createQueryBuilder('ledger')
            .select('ledger.minerAddress', 'minerAddress')
            .addSelect('SUM(ledger.amountSats)', 'totalPendingSats')
            .addSelect('MAX(ledger.id)', 'maxRowId')
            .where('ledger.status = :status', { status: ePayoutStatus.PENDING })
            .groupBy('ledger.minerAddress')
            .getRawMany();

        return rows.map(row => ({
            minerAddress: row.minerAddress,
            totalPendingSats: Number(row.totalPendingSats),
            maxRowId: Number(row.maxRowId),
        }));
    }

    // Same as getAllPendingTotals, but only sums credits from blocks that
    // have themselves individually reached coinbase maturity (blockHeight
    // <= matureUpToHeight). A miner who keeps finding new blocks would
    // otherwise never get paid under the old all-or-nothing total: every
    // fresh (immature) credit raised what the wallet needed to cover before
    // anything could go out at all, even funds that had long since matured.
    // Rows from blocks that haven't matured yet are simply left PENDING and
    // picked up once they do.
    public async getMaturePendingTotals(matureUpToHeight: number): Promise<IPendingPayoutCandidate[]> {
        const rows = await this.payoutLedgerRepository
            .createQueryBuilder('ledger')
            .select('ledger.minerAddress', 'minerAddress')
            .addSelect('SUM(ledger.amountSats)', 'totalPendingSats')
            .addSelect('MAX(ledger.id)', 'maxRowId')
            .where('ledger.status = :status', { status: ePayoutStatus.PENDING })
            .andWhere('ledger.blockHeight <= :matureUpToHeight', { matureUpToHeight })
            .groupBy('ledger.minerAddress')
            .getRawMany();

        return rows.map(row => ({
            minerAddress: row.minerAddress,
            totalPendingSats: Number(row.totalPendingSats),
            maxRowId: Number(row.maxRowId),
        }));
    }

    public async markSentUpTo(minerAddress: string, maxRowId: number, txid: string): Promise<void> {
        await this.payoutLedgerRepository
            .createQueryBuilder()
            .update(PayoutLedgerEntity)
            .set({ status: ePayoutStatus.SENT, txid })
            .where('minerAddress = :minerAddress', { minerAddress })
            .andWhere('id <= :maxRowId', { maxRowId })
            .andWhere('status = :status', { status: ePayoutStatus.PENDING })
            .execute();
    }

    public async getDistinctSentTxids(): Promise<string[]> {
        const rows = await this.payoutLedgerRepository
            .createQueryBuilder('ledger')
            .select('DISTINCT ledger.txid', 'txid')
            .where('ledger.status = :status', { status: ePayoutStatus.SENT })
            .getRawMany();
        return rows.map(row => row.txid).filter((txid: string | null) => txid != null);
    }

    public async markConfirmed(txid: string): Promise<void> {
        await this.payoutLedgerRepository
            .createQueryBuilder()
            .update(PayoutLedgerEntity)
            .set({ status: ePayoutStatus.CONFIRMED })
            .where('txid = :txid', { txid })
            .andWhere('status = :status', { status: ePayoutStatus.SENT })
            .execute();
    }

    public async getPayoutHistory(minerAddress: string, limit = 100) {
        return await this.payoutLedgerRepository.find({
            where: [
                { minerAddress, status: ePayoutStatus.SENT },
                { minerAddress, status: ePayoutStatus.CONFIRMED },
            ],
            order: { updatedAt: 'DESC' },
            take: limit,
        });
    }

    public async getTotalPaid(minerAddress: string): Promise<number> {
        const result = await this.payoutLedgerRepository
            .createQueryBuilder('ledger')
            .select('COALESCE(SUM(ledger.amountSats), 0)', 'total')
            .where('ledger.minerAddress = :minerAddress', { minerAddress })
            .andWhere('ledger.status IN (:...statuses)', { statuses: [ePayoutStatus.SENT, ePayoutStatus.CONFIRMED] })
            .getRawOne();
        return Number(result?.total ?? 0);
    }

    public async getLastPayoutAt(minerAddress: string): Promise<Date | null> {
        const row = await this.payoutLedgerRepository
            .createQueryBuilder('ledger')
            .where('ledger.minerAddress = :minerAddress', { minerAddress })
            .andWhere('ledger.status IN (:...statuses)', { statuses: [ePayoutStatus.SENT, ePayoutStatus.CONFIRMED] })
            .orderBy('ledger.updatedAt', 'DESC')
            .getOne();
        return row?.updatedAt ?? null;
    }
}
