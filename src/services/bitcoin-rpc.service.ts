import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import * as fs from 'node:fs';
import { BehaviorSubject, filter, shareReplay } from 'rxjs';
import * as zmq from 'zeromq';

import { RpcBlockService } from '../ORM/rpc-block/rpc-block.service';
import { IBlockTemplate } from '../models/bitcoin-rpc/IBlockTemplate';
import { IMiningInfo } from '../models/bitcoin-rpc/IMiningInfo';

@Injectable()
export class BitcoinRpcService implements OnModuleInit {

    private blockHeight = 0;
    private client: AxiosInstance;
    private rpcRequestId = 0;
    private _newBlock$: BehaviorSubject<IMiningInfo> = new BehaviorSubject(undefined);
    public newBlock$ = this._newBlock$.pipe(filter(block => block != null), shareReplay({ refCount: true, bufferSize: 1 }));

    constructor(
        private readonly configService: ConfigService,
        private rpcBlockService: RpcBlockService
    ) {
    }

    async onModuleInit() {
        // Prefer ELEKTRON_RPC_* env vars; fall back to legacy BITCOIN_RPC_* names so
        // existing deployments keep working during the rename.
        const cfg = (newKey: string, oldKey: string) =>
            this.configService.get(newKey) ?? this.configService.get(oldKey);

        const url = cfg('ELEKTRON_RPC_URL', 'BITCOIN_RPC_URL');
        let user = cfg('ELEKTRON_RPC_USER', 'BITCOIN_RPC_USER');
        let pass = cfg('ELEKTRON_RPC_PASSWORD', 'BITCOIN_RPC_PASSWORD');
        const port = parseInt(cfg('ELEKTRON_RPC_PORT', 'BITCOIN_RPC_PORT'));
        const timeout = parseInt(cfg('ELEKTRON_RPC_TIMEOUT', 'BITCOIN_RPC_TIMEOUT'));

        const cookiefile = cfg('ELEKTRON_RPC_COOKIEFILE', 'BITCOIN_RPC_COOKIEFILE');

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
                password: pass
            },
            // Bitcoin-Core-style JSON-RPC servers respond with HTTP 500 (not
            // 200) whenever the RPC call itself errors -- verified live
            // against WalletRpcService's identical client. Axios's default
            // validateStatus rejects any non-2xx as a generic AxiosError
            // before callRpc() reads response.data.error, discarding the
            // actual RPC error code/message. Accept every status and always
            // parse the JSON-RPC envelope ourselves instead.
            validateStatus: () => true,
        });

        this.callRpc('getrpcinfo').then(() => {
            console.log('Elektron RPC connected');
        }, () => {
            console.error('Could not reach RPC host');
        });

        const zmqHost = cfg('ELEKTRON_ZMQ_HOST', 'BITCOIN_ZMQ_HOST');
        if (zmqHost) {
            console.log('Using ZMQ');
            const sock = new zmq.Subscriber;


            sock.connectTimeout = 1000;
            sock.events.on('connect', () => {
                console.log('ZMQ Connected');
            });
            sock.events.on('connect:retry', () => {
                console.log('ZMQ Unable to connect, Retrying');
            });

            sock.connect(zmqHost);
            sock.subscribe('rawblock');
            // Don't await this, otherwise it will block the rest of the program
            this.listenForNewBlocks(sock);
            await this.pollMiningInfo();

        } else {
            setInterval(this.pollMiningInfo.bind(this), 500);
        }
    }

    private async listenForNewBlocks(sock: zmq.Subscriber) {
        for await (const [topic, msg] of sock) {
            console.log("New Block");
            await this.pollMiningInfo();
        }
    }

    public async pollMiningInfo() {
        const miningInfo = await this.getMiningInfo();
        if (miningInfo != null && miningInfo.blocks > this.blockHeight) {
            console.log("block height change");
            this._newBlock$.next(miningInfo);
            this.blockHeight = miningInfo.blocks;
        }
    }

    private async waitForBlock(blockHeight: number): Promise<IBlockTemplate> {
        while (true) {
            await new Promise(r => setTimeout(r, 100));

            const block = await this.rpcBlockService.getBlock(blockHeight);
            if (block != null && block.data != null) {
                return Promise.resolve(JSON.parse(block.data));
            }
        }
    }

    // Elektron Net: the node computes the per-block UTXO attestation hash against
    // the template's coinbase, which uses the address passed in `coinbaseaddress`.
    // The pool must request a separate template per miner payout address —
    // otherwise the submitted coinbase output won't match the template and the
    // node rejects the block with `bad-utxo-attestation`. A single template
    // cannot be shared across miners as in plain Bitcoin pools.
    public async getBlockTemplate(coinbaseAddress: string): Promise<IBlockTemplate> {
        if (!coinbaseAddress) {
            throw new Error('getBlockTemplate requires coinbaseAddress for Elektron Net UTXO attestation');
        }
        let result: IBlockTemplate;
        try {
            result = await this.loadBlockTemplate(coinbaseAddress);
        } catch (e) {
            console.error('Error getblocktemplate:', e.message);
            throw new Error('Error getblocktemplate');
        }
        return result;
    }

    private async loadBlockTemplate(coinbaseAddress: string) {

        let blockTemplate: IBlockTemplate;
        while (blockTemplate == null) {
            blockTemplate = await this.callRpc<IBlockTemplate>('getblocktemplate', [
                {
                    rules: ['segwit'],
                    mode: 'template',
                    capabilities: ['serverlist', 'proposal'],
                    coinbaseaddress: coinbaseAddress
                }
            ]);
        }

        return blockTemplate;
    }

    public async getMiningInfo(): Promise<IMiningInfo> {
        try {
            return await this.callRpc<IMiningInfo>('getmininginfo');
        } catch (e) {
            console.error('Error getmininginfo', e.message);
            return null;
        }

    }

    // Concept doc §11 (login alternative): Elektron Net's wallet software
    // does not support signmessage for SegWit/bech32 addresses (P2PKH-only),
    // so AuthService falls back to an on-chain proof for addresses that
    // can't sign a message -- the miner sends themselves (self-send) an
    // exact, nonce-derived amount, and this scans the *current* UTXO set
    // (not the wallet's own UTXOs, so it works for any address, not just
    // ones the pool's own wallet controls) for a matching unspent output.
    // scantxoutset works on a pruned node too (pruning drops old block/tx
    // data, not the current UTXO set), so this doesn't require txindex.
    public async scanAddressForAmountSats(address: string, expectedAmountSats: number): Promise<boolean> {
        const result = await this.callRpc<{ success: boolean; unspents: { amount: number }[] }>(
            'scantxoutset',
            ['start', [{ desc: `addr(${address})` }]],
        );
        if (result?.success !== true || !Array.isArray(result.unspents)) {
            return false;
        }
        return result.unspents.some(utxo => Math.round(utxo.amount * 1e8) === expectedAmountSats);
    }

    public async SUBMIT_BLOCK(hexdata: string): Promise<string> {
        let response: string = 'unknown';
        try {
            response = await this.callRpc<string>('submitblock', [hexdata]);
            if (response == null) {
                response = 'SUCCESS!';
            }
            console.log(`BLOCK SUBMISSION RESPONSE: ${response}`);
            console.log(hexdata);
            console.log(JSON.stringify(response));
        } catch (e) {
            response = e;
            console.log(`BLOCK SUBMISSION RESPONSE ERROR: ${e}`);
        }
        return response;

    }

    private async callRpc<T>(method: string, params: unknown[] = []): Promise<T> {
        const response = await this.client.post('', {
            jsonrpc: '1.0',
            id: ++this.rpcRequestId,
            method,
            params
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
