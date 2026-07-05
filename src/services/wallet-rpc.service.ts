import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import * as fs from 'node:fs';

// Concept doc §9: the pool wallet holds cumulative PPLNS rewards in trust for
// all miners, so its RPC endpoint is kept separate from the pool node's
// getblocktemplate RPC (BitcoinRpcService) from day one — WALLET_RPC_HOST/PORT
// default to the pool node's own connection details (Scenario A, single
// server) but can point at a dedicated wallet server (Scenario B, §9.3) via
// config alone, without a code change.
const DEFAULT_WALLET_UNLOCK_SECONDS = 60;
// Elektron Net's own network minimum (DEFAULT_MIN_RELAY_TX_FEE, policy.h) --
// used as the payout fallback fee rate when estimatesmartfee has no data yet
// (a young chain with too little fee history) and -fallbackfee is disabled
// on the node (Bitcoin Core's own default, matched here).
const DEFAULT_FALLBACK_FEE_SATS_PER_KVB = 100;

@Injectable()
export class WalletRpcService implements OnModuleInit {

    private client: AxiosInstance;
    private rpcRequestId = 0;
    private walletPassphrase: string | undefined;
    private walletUnlockSeconds: number;

    constructor(
        private readonly configService: ConfigService,
    ) {
    }

    onModuleInit() {
        const cfg = (walletKey: string, nodeFallbackKey: string) =>
            this.configService.get(walletKey) ?? this.configService.get(nodeFallbackKey);

        const url = cfg('WALLET_RPC_HOST', 'ELEKTRON_RPC_URL');
        let user = cfg('WALLET_RPC_USER', 'ELEKTRON_RPC_USER');
        let pass = cfg('WALLET_RPC_PASSWORD', 'ELEKTRON_RPC_PASSWORD');
        const port = parseInt(cfg('WALLET_RPC_PORT', 'ELEKTRON_RPC_PORT'));
        const timeout = parseInt(this.configService.get('WALLET_RPC_TIMEOUT')) || 30000;

        const cookiefile = this.configService.get('WALLET_RPC_COOKIEFILE');
        if (cookiefile != undefined && cookiefile != '') {
            const cookie = fs.readFileSync(cookiefile).toString().trim().split(':');
            user = cookie[0];
            pass = cookie[1];
        }

        // Only set if the wallet is encrypted (`encryptwallet` was run on it).
        // An unencrypted wallet needs no unlocking at all, and calling
        // walletpassphrase/walletlock against one is itself an RPC error
        // ("running with an unencrypted wallet") -- see sendManySats().
        this.walletPassphrase = this.configService.get('WALLET_PASSPHRASE') || undefined;
        const unlockSeconds = parseInt(this.configService.get<string>('WALLET_UNLOCK_SECONDS'), 10);
        this.walletUnlockSeconds = Number.isFinite(unlockSeconds) && unlockSeconds > 0
            ? unlockSeconds
            : DEFAULT_WALLET_UNLOCK_SECONDS;

        const walletName = this.configService.get<string>('WALLET_RPC_WALLET_NAME');
        const baseURL = this.buildRpcUrl(url, port, walletName);
        this.client = axios.create({
            baseURL,
            timeout,
            auth: {
                username: user,
                password: pass,
            },
            // Bitcoin-Core-style JSON-RPC servers respond with HTTP 500 (not
            // 200) whenever the RPC call itself errors (verified live: e.g.
            // code -13 "please enter the wallet passphrase" comes back as a
            // 500). Axios's default validateStatus rejects any non-2xx as a
            // generic AxiosError *before* callRpc() ever gets to read
            // response.data.error -- silently discarding the actual RPC error
            // code/message callers like PayoutSchedulerService rely on
            // (e.g. its "wallet is encrypted" hint keyed on error.code === -13).
            // Accepting every status here and always parsing the JSON-RPC
            // envelope ourselves makes real error codes reach the caller.
            validateStatus: () => true,
        });
    }

    // sendmany-equivalent batch payout. Amounts are in lepton (Elektron's
    // smallest unit); the RPC wants ELEK-denominated decimal strings, hence
    // the fixed(8) conversion (avoids floating point artifacts like 0.1+0.2).
    //
    // If WALLET_PASSPHRASE is configured (encrypted wallet), the wallet is
    // unlocked just long enough for this one call and explicitly re-locked
    // immediately after -- deliberately not left unlocked for the full
    // PAYOUT_INTERVAL_MINUTES between cycles, since that would defeat most of
    // the point of encrypting it in the first place.
    public async sendManySats(payouts: { address: string; amountSats: number }[]): Promise<string> {
        const amounts: Record<string, string> = {};
        for (const payout of payouts) {
            amounts[payout.address] = (payout.amountSats / 1e8).toFixed(8);
        }

        const comment = 'PPLNS batch payout';
        const minConfirmations = 1;

        if (this.walletPassphrase == null) {
            return await this.sendManyWithFeeFallback(amounts, minConfirmations, comment);
        }

        await this.callRpc('walletpassphrase', [this.walletPassphrase, this.walletUnlockSeconds]);
        try {
            return await this.sendManyWithFeeFallback(amounts, minConfirmations, comment);
        } finally {
            try {
                await this.callRpc('walletlock', []);
            } catch (e) {
                // Non-fatal: the unlock timeout above still expires on its own,
                // and callRpc already threw for the actual sendmany result.
                console.warn(`Failed to explicitly re-lock the wallet after payout attempt: ${e?.message ?? e}`);
            }
        }
    }

    // A young chain often doesn't have enough fee history yet for
    // estimatesmartfee, and -fallbackfee is disabled by default (same as
    // modern Bitcoin Core) -- sendmany then fails outright instead of
    // guessing ("Fee estimation failed. Fallbackfee is disabled."). Rather
    // than requiring every node operator to set -fallbackfee, retry once
    // with an explicit fixed fee rate (PAYOUT_FALLBACK_FEE_SATS_PER_KVB,
    // defaulting to Elektron Net's own network minimum) via settxfee, then
    // immediately restore automatic estimation (settxfee 0) so later cycles
    // benefit once the chain has enough data for estimatesmartfee to work.
    private async sendManyWithFeeFallback(amounts: Record<string, string>, minConfirmations: number, comment: string): Promise<string> {
        try {
            return await this.callRpc<string>('sendmany', ['', amounts, minConfirmations, comment]);
        } catch (e) {
            if (!this.isFeeEstimationFailure(e)) {
                throw e;
            }

            const fallbackFeeSatsPerKvb = this.getFallbackFeeSatsPerKvb();
            console.warn(
                `Fee estimation unavailable (network likely too young to have enough fee data yet) -- `
                + `retrying this payout with a fixed fallback fee of ${fallbackFeeSatsPerKvb} lep/kvB.`,
            );

            await this.callRpc('settxfee', [(fallbackFeeSatsPerKvb / 1e8).toFixed(8)]);
            try {
                return await this.callRpc<string>('sendmany', ['', amounts, minConfirmations, comment]);
            } finally {
                try {
                    await this.callRpc('settxfee', [0]);
                } catch (e2) {
                    console.warn(`Failed to restore automatic fee estimation after the fallback payout attempt: ${e2?.message ?? e2}`);
                }
            }
        }
    }

    private isFeeEstimationFailure(e: any): boolean {
        return typeof e?.message === 'string' && e.message.toLowerCase().includes('fee estimation failed');
    }

    private getFallbackFeeSatsPerKvb(): number {
        const configured = parseInt(this.configService.get<string>('PAYOUT_FALLBACK_FEE_SATS_PER_KVB'), 10);
        return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_FALLBACK_FEE_SATS_PER_KVB;
    }

    public async getConfirmations(txid: string): Promise<number> {
        const result = await this.callRpc<{ confirmations: number }>('gettransaction', [txid]);
        return result.confirmations ?? 0;
    }

    public async getWalletBalanceSats(): Promise<number> {
        const result = await this.callRpc<number>('getbalance');
        return Math.round(result * 1e8);
    }

    // Spendable (mature, confirmed) balance plus still-immature coinbase --
    // i.e. everything the wallet actually holds, regardless of whether it's
    // spendable yet. Used for reconciliation against the *total* pending
    // ledger (which also includes not-yet-mature credits) -- getbalance()
    // alone would look like a permanent shortfall any time there's recently
    // found, still-immature blocks, which is the normal/expected state for
    // an actively mining pool, not a mismatch.
    public async getWalletTotalBalanceSats(): Promise<number> {
        const result = await this.callRpc<{ balance: number; immature_balance: number }>('getwalletinfo');
        return Math.round((result.balance + result.immature_balance) * 1e8);
    }

    private async callRpc<T>(method: string, params: unknown[] = []): Promise<T> {
        const response = await this.client.post('', {
            jsonrpc: '1.0',
            id: ++this.rpcRequestId,
            method,
            params,
        });

        if (response.data.error != null) {
            throw response.data.error;
        }

        return response.data.result;
    }

    // Bitcoin-Core-style nodes with more than one wallet loaded reject
    // wallet RPCs made against the bare "/" endpoint ("Multiple wallets are
    // loaded...") -- they must be addressed as /wallet/<name> instead. A
    // node with only one wallet loaded accepts both forms, so this is safe
    // to always apply once WALLET_RPC_WALLET_NAME is set.
    private buildRpcUrl(url: string, port: number, walletName?: string): string {
        const normalizedUrl = /^https?:\/\//i.test(url) ? url : `http://${url}`;
        const rpcUrl = new URL(normalizedUrl);
        if (Number.isFinite(port) && port > 0) {
            rpcUrl.port = port.toString();
        }
        if (walletName != null && walletName.length > 0) {
            rpcUrl.pathname = `/wallet/${encodeURIComponent(walletName)}`;
        }
        return rpcUrl.toString();
    }
}
