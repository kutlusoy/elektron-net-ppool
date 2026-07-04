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
@Injectable()
export class WalletRpcService implements OnModuleInit {

    private client: AxiosInstance;
    private rpcRequestId = 0;

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

        const baseURL = this.buildRpcUrl(url, port);
        this.client = axios.create({
            baseURL,
            timeout,
            auth: {
                username: user,
                password: pass,
            },
        });
    }

    // sendmany-equivalent batch payout. Amounts are in satoshis; the RPC wants
    // BTC-denominated decimal strings, hence the fixed(8) conversion (avoids
    // floating point artifacts like 0.1+0.2).
    public async sendManySats(payouts: { address: string; amountSats: number }[]): Promise<string> {
        const amounts: Record<string, string> = {};
        for (const payout of payouts) {
            amounts[payout.address] = (payout.amountSats / 1e8).toFixed(8);
        }

        const comment = 'PPLNS batch payout';
        const minConfirmations = 1;
        const result = await this.callRpc<string>('sendmany', ['', amounts, minConfirmations, comment]);
        return result;
    }

    public async getConfirmations(txid: string): Promise<number> {
        const result = await this.callRpc<{ confirmations: number }>('gettransaction', [txid]);
        return result.confirmations ?? 0;
    }

    public async getWalletBalanceSats(): Promise<number> {
        const result = await this.callRpc<number>('getbalance');
        return Math.round(result * 1e8);
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

    private buildRpcUrl(url: string, port: number): string {
        const normalizedUrl = /^https?:\/\//i.test(url) ? url : `http://${url}`;
        const rpcUrl = new URL(normalizedUrl);
        if (Number.isFinite(port) && port > 0) {
            rpcUrl.port = port.toString();
        }
        return rpcUrl.toString();
    }
}
