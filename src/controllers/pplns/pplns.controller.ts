import { Controller, Get, Param } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PayoutLedgerService } from '../../ORM/payout-ledger/payout-ledger.service';
import { PplnsShareLogService } from '../../ORM/pplns-shares/pplns-shares.service';

const DEFAULT_MIN_PAYOUT_THRESHOLD_SATS = 100000;
const DEFAULT_PAYOUT_INTERVAL_MINUTES = 60;
const DEFAULT_FEE_PERCENT = 0;

// Concept doc §10.3: thin read-only wrappers over the PPLNS services, for the
// elektron-net-ppool-ui dashboard.
@Controller()
export class PplnsController {

    constructor(
        private readonly payoutLedgerService: PayoutLedgerService,
        private readonly pplnsShareLogService: PplnsShareLogService,
        private readonly configService: ConfigService,
    ) {
    }

    @Get('miner/:address/pending-balance')
    async getPendingBalance(@Param('address') address: string) {
        const [pendingSats, totalPaidSats, lastPayoutAt] = await Promise.all([
            this.payoutLedgerService.getPendingTotal(address),
            this.payoutLedgerService.getTotalPaid(address),
            this.payoutLedgerService.getLastPayoutAt(address),
        ]);

        return { pendingSats, lastPayoutAt, totalPaidSats };
    }

    @Get('miner/:address/payout-history')
    async getPayoutHistory(@Param('address') address: string) {
        const rows = await this.payoutLedgerService.getPayoutHistory(address);
        return rows.map(row => ({
            blockHeight: row.blockHeight,
            amountSats: row.amountSats,
            txid: row.txid,
            status: row.status,
            timestamp: row.updatedAt,
        }));
    }

    @Get('pool/pplns-window-stats')
    async getPplnsWindowStats() {
        const windowMinutes = this.pplnsShareLogService.getWindowMinutes();
        const windowStart = Date.now() - windowMinutes * 60 * 1000;
        const { totalDifficultyInWindow, activeMinerCount } = await this.pplnsShareLogService.getWindowStats(windowStart);

        return { windowMinutes, totalDifficultyInWindow, activeMinerCount };
    }

    @Get('pool/fee-info')
    async getFeeInfo() {
        const feePercent = parseFloat(this.configService.get<string>('POOL_FEE_PERCENT'));
        const minPayoutThresholdSats = parseInt(this.configService.get<string>('MIN_PAYOUT_THRESHOLD_SATS'), 10);
        const payoutIntervalMinutes = parseInt(this.configService.get<string>('PAYOUT_INTERVAL_MINUTES'), 10);

        return {
            feePercent: Number.isFinite(feePercent) ? feePercent : DEFAULT_FEE_PERCENT,
            minPayoutThresholdSats: Number.isFinite(minPayoutThresholdSats) ? minPayoutThresholdSats : DEFAULT_MIN_PAYOUT_THRESHOLD_SATS,
            payoutIntervalMinutes: Number.isFinite(payoutIntervalMinutes) ? payoutIntervalMinutes : DEFAULT_PAYOUT_INTERVAL_MINUTES,
        };
    }
}
