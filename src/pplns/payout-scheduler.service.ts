import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PayoutLedgerService } from '../ORM/payout-ledger/payout-ledger.service';
import { WalletRpcService } from '../services/wallet-rpc.service';

const DEFAULT_MIN_PAYOUT_THRESHOLD_SATS = 100000;
const DEFAULT_PAYOUT_INTERVAL_MINUTES = 60;
const DEFAULT_CONFIRMATIONS_REQUIRED = 1;
// §9.3.2: alert rather than auto-correct on a pool-DB vs wallet mismatch.
// Allow a small tolerance for sats already earmarked as fee/dust that never
// hit the ledger as a miner credit.
const RECONCILIATION_TOLERANCE_SATS = 100000;

// Concept doc §5.4: accumulate balances per miner (via PayoutLedgerService)
// and pay out via a batch transaction once the threshold is reached.
// Idempotency: a payout cycle only claims the PENDING rows that existed when
// it started (see PayoutLedgerService.getPendingTotalsAboveThreshold), and a
// failed/timed-out sendmany call leaves those rows PENDING for the next
// cycle instead of guessing whether the transaction actually went out.
@Injectable()
export class PayoutSchedulerService implements OnModuleInit {

    constructor(
        private readonly payoutLedger: PayoutLedgerService,
        private readonly walletRpc: WalletRpcService,
        private readonly configService: ConfigService,
    ) {
    }

    onModuleInit() {
        // Single-runner guard, consistent with LogRotationService/PplnsShareLogService.
        if (process.env.NODE_APP_INSTANCE != null && process.env.NODE_APP_INSTANCE !== '0') {
            return;
        }

        const intervalMs = this.getIntervalMinutes() * 60 * 1000;
        setInterval(() => {
            this.runPayoutCycle().catch(e => console.error(`PPLNS payout cycle failed: ${e?.message ?? e}`));
            this.reconcileSentPayouts().catch(e => console.error(`PPLNS payout reconciliation failed: ${e?.message ?? e}`));
            this.checkPoolWalletReconciliation().catch(e => console.error(`PPLNS wallet balance check failed: ${e?.message ?? e}`));
        }, intervalMs);
    }

    public async runPayoutCycle(): Promise<void> {
        const thresholdSats = this.getMinPayoutThresholdSats();
        const candidates = await this.payoutLedger.getPendingTotalsAboveThreshold(thresholdSats);
        if (candidates.length === 0) {
            return;
        }

        if (this.isDryRun()) {
            console.log(`PPLNS payout DRY_RUN: would pay out ${candidates.length} miner(s): ${JSON.stringify(candidates)}`);
            return;
        }

        let txid: string;
        try {
            txid = await this.walletRpc.sendManySats(
                candidates.map(c => ({ address: c.minerAddress, amountSats: c.totalPendingSats })),
            );
        } catch (e) {
            // Never resend on failure/timeout without confirming what happened
            // on the wallet side first (§9.3.3) — the safest default is to
            // leave the ledger rows PENDING and retry next cycle, and require
            // an operator to check the wallet log/mempool if this repeats.
            console.error(`PPLNS payout batch failed (will retry next cycle): ${e?.message ?? e}`);
            return;
        }

        for (const candidate of candidates) {
            await this.payoutLedger.markSentUpTo(candidate.minerAddress, candidate.maxRowId, txid);
        }

        console.log(`PPLNS payout batch sent: txid=${txid}, miners=${candidates.length}, totalSats=${candidates.reduce((sum, c) => sum + c.totalPendingSats, 0)}`);
    }

    public async reconcileSentPayouts(): Promise<void> {
        const requiredConfirmations = this.getConfirmationsRequired();
        const txids = await this.payoutLedger.getDistinctSentTxids();
        for (const txid of txids) {
            try {
                const confirmations = await this.walletRpc.getConfirmations(txid);
                if (confirmations >= requiredConfirmations) {
                    await this.payoutLedger.markConfirmed(txid);
                }
            } catch (e) {
                console.warn(`Could not check confirmations for payout txid ${txid}: ${e?.message ?? e}`);
            }
        }
    }

    public async checkPoolWalletReconciliation(): Promise<void> {
        try {
            const [walletBalanceSats, totalPendingSats] = await Promise.all([
                this.walletRpc.getWalletBalanceSats(),
                this.payoutLedger.getTotalPendingAcrossAllMiners(),
            ]);

            if (walletBalanceSats + RECONCILIATION_TOLERANCE_SATS < totalPendingSats) {
                console.error(
                    `PPLNS RECONCILIATION MISMATCH: pool wallet balance (${walletBalanceSats} sats) is below `
                    + `total miner balances owed (${totalPendingSats} sats). Manual investigation required — `
                    + `this alert does not auto-correct anything.`,
                );
            }
        } catch (e) {
            console.warn(`PPLNS wallet reconciliation check could not run: ${e?.message ?? e}`);
        }
    }

    private isDryRun(): boolean {
        return this.configService.get<string>('PAYOUT_DRY_RUN')?.toLowerCase() === 'true';
    }

    private getMinPayoutThresholdSats(): number {
        const configured = parseInt(this.configService.get<string>('MIN_PAYOUT_THRESHOLD_SATS'), 10);
        return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MIN_PAYOUT_THRESHOLD_SATS;
    }

    private getIntervalMinutes(): number {
        const configured = parseInt(this.configService.get<string>('PAYOUT_INTERVAL_MINUTES'), 10);
        return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_PAYOUT_INTERVAL_MINUTES;
    }

    private getConfirmationsRequired(): number {
        const configured = parseInt(this.configService.get<string>('PAYOUT_CONFIRMATIONS_REQUIRED'), 10);
        return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_CONFIRMATIONS_REQUIRED;
    }
}
