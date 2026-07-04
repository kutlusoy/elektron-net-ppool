import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PayoutLedgerService } from '../ORM/payout-ledger/payout-ledger.service';
import { PoolAccountingService } from '../ORM/pool-accounting/pool-accounting.service';
import { PplnsShareLogService } from '../ORM/pplns-shares/pplns-shares.service';

const DEFAULT_FEE_PERCENT = 0;

// Concept doc §5.3: on block found, read the shares within the PPLNS window,
// weight them per miner, deduct the pool fee, and credit the payout ledger.
@Injectable()
export class RewardCalculatorService {

    constructor(
        private readonly shareLog: PplnsShareLogService,
        private readonly payoutLedger: PayoutLedgerService,
        private readonly poolAccounting: PoolAccountingService,
        private readonly configService: ConfigService,
    ) {
    }

    public async processBlockFound(blockHeight: number, blockRewardSats: number): Promise<void> {
        const windowMinutes = this.shareLog.getWindowMinutes();
        const windowStart = Date.now() - windowMinutes * 60 * 1000;

        const shares = await this.shareLog.getSharesInWindow(windowStart);
        const totalDifficulty = shares.reduce((sum, s) => sum + s.difficulty, 0);

        if (totalDifficulty <= 0) {
            // No shares in the window (e.g. very first block after startup) —
            // nothing to distribute against. Route the entire reward to pool
            // accounting rather than crediting nobody or dividing by zero.
            console.error(`PPLNS: block ${blockHeight} found with zero difficulty in the ${windowMinutes}min window — reward routed to pool accounting for manual review`);
            await this.poolAccounting.addFeeAndDust(0, blockRewardSats);
            return;
        }

        const feePercent = this.getFeePercent();
        const distributable = Math.floor(blockRewardSats * (1 - feePercent / 100));
        const feeSats = blockRewardSats - distributable;

        const perMinerTotals = new Map<string, number>();
        for (const share of shares) {
            const proportion = share.difficulty / totalDifficulty;
            const amount = Math.floor(distributable * proportion);
            perMinerTotals.set(
                share.minerAddress,
                (perMinerTotals.get(share.minerAddress) ?? 0) + amount,
            );
        }

        let allocatedSats = 0;
        for (const [address, amount] of perMinerTotals) {
            if (amount <= 0) {
                continue;
            }
            await this.payoutLedger.credit(address, amount, blockHeight);
            allocatedSats += amount;
        }

        const dustSats = distributable - allocatedSats;
        await this.poolAccounting.addFeeAndDust(feeSats, dustSats);

        console.log(`PPLNS: block ${blockHeight} reward ${blockRewardSats} lep split among ${perMinerTotals.size} miners (fee=${feeSats}, dust=${dustSats})`);
    }

    private getFeePercent(): number {
        const configured = parseFloat(this.configService.get<string>('POOL_FEE_PERCENT'));
        return Number.isFinite(configured) && configured >= 0 && configured < 100 ? configured : DEFAULT_FEE_PERCENT;
    }
}
