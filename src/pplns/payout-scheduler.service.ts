import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PayoutLedgerService } from '../ORM/payout-ledger/payout-ledger.service';
import { MinerAccountSettingsService } from '../ORM/miner-account-settings/miner-account-settings.service';
import { NotificationService } from '../services/notification.service';
import { WalletRpcService } from '../services/wallet-rpc.service';

const DEFAULT_MIN_PAYOUT_THRESHOLD_SATS = 100000;
const DEFAULT_PAYOUT_INTERVAL_MINUTES = 60;
const DEFAULT_CONFIRMATIONS_REQUIRED = 1;
// §9.3.2: alert rather than auto-correct on a pool-DB vs wallet mismatch.
// Allow a small tolerance for lep already earmarked as fee/dust that never
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
        private readonly minerAccountSettings: MinerAccountSettingsService,
        private readonly notificationService: NotificationService,
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
        const poolThresholdSats = this.getMinPayoutThresholdSats();
        const allPending = await this.payoutLedger.getAllPendingTotals();
        if (allPending.length === 0) {
            return;
        }

        // Concept doc §11: a miner's own payoutThresholdSatsOverride wins over
        // the pool-wide default when set (e.g. someone who wants to be paid
        // out sooner/later than everyone else).
        const overrides = await this.minerAccountSettings.getOverridesByAddress(allPending.map(c => c.minerAddress));
        const candidates = allPending.filter(c => c.totalPendingSats >= (overrides.get(c.minerAddress) ?? poolThresholdSats));
        if (candidates.length === 0) {
            return;
        }

        if (this.isDryRun()) {
            console.log(`PPLNS payout DRY_RUN: would pay out ${candidates.length} miner(s): ${JSON.stringify(candidates)}`);
            return;
        }

        // Ledger credits land the moment a block is found (§5.3), independent
        // of coinbase maturity -- the wallet may simply not have enough
        // *spendable* balance yet to cover the batch (immature coinbases
        // don't count towards getbalance's spendable total). sendmany would
        // fail safely either way (no partial/incorrect payment, see the catch
        // below), but checking first avoids repeatedly hitting the RPC with a
        // doomed request every cycle and gives a clear, specific log line
        // instead of a generic wallet error.
        const totalRequestedSats = candidates.reduce((sum, c) => sum + c.totalPendingSats, 0);
        const spendableSats = await this.walletRpc.getWalletBalanceSats();
        if (spendableSats < totalRequestedSats) {
            console.log(
                `PPLNS payout deferred: ${totalRequestedSats} lep owed but only ${spendableSats} lep spendable `
                + `(the rest is likely still immature coinbase — will retry once it matures).`,
            );
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
            // RPC code -13 specifically means the wallet is encrypted and
            // WALLET_PASSPHRASE isn't set (or is wrong) — call that out
            // explicitly since it's the most common first-deployment mistake.
            const hint = e?.code === -13 ? ' (wallet is encrypted — set WALLET_PASSPHRASE in .env)' : '';
            console.error(`PPLNS payout batch failed (will retry next cycle)${hint}: ${e?.message ?? e}`);
            return;
        }

        for (const candidate of candidates) {
            await this.payoutLedger.markSentUpTo(candidate.minerAddress, candidate.maxRowId, txid);
        }

        console.log(`PPLNS payout batch sent: txid=${txid}, miners=${candidates.length}, totalLep=${candidates.reduce((sum, c) => sum + c.totalPendingSats, 0)}`);

        const notifyAddresses = await this.minerAccountSettings.getNotifyOnPayoutAddresses(candidates.map(c => c.minerAddress));
        await Promise.all(candidates
            .filter(c => notifyAddresses.has(c.minerAddress))
            .map(c => this.notificationService.notifyPayoutSent(c.minerAddress, c.totalPendingSats, txid)
                .catch(e => console.warn(`Payout notification failed for ${c.minerAddress}: ${e?.message ?? e}`))));
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
                    `PPLNS RECONCILIATION MISMATCH: pool wallet balance (${walletBalanceSats} lep) is below `
                    + `total miner balances owed (${totalPendingSats} lep). Manual investigation required — `
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
