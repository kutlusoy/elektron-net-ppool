import { Injectable } from '@nestjs/common';
import * as bitcoinjs from 'bitcoinjs-lib';
import * as merkle from 'merkle-lib';
import * as merkleProof from 'merkle-lib/proof';

import { MiningJob } from '../models/MiningJob';
import { BitcoinRpcService } from './bitcoin-rpc.service';

export interface IJobTemplate {

    block: bitcoinjs.Block;
    merkle_branch: string[];
    // Elektron Net: required coinbase outputs (UTXO attestation + witness commitment),
    // passed through verbatim from getblocktemplate. Optional so legacy/Bitcoin
    // templates without this field still work (falls back to block.witnessCommit).
    coinbase_required_outputs?: { value: number; scriptPubKey: Buffer }[];
    coinbase_script_sig_prefix?: Buffer;
    blockData: {
        id: string,
        creation: number,
        coinbasevalue: number;
        networkDifficulty: number;
        height: number;
        clearJobs: boolean;
    };
}

@Injectable()
export class StratumV1JobsService {

    public latestJobId: number = 1;
    public latestJobTemplateId: number = 1;

    public jobs: { [jobId: string]: MiningJob } = {};

    public blocks: { [id: string]: IJobTemplate } = {};

    // Track the tip height the last template was fetched at, per miner address.
    // Used by clients to decide whether to clear active jobs when a new template
    // arrives at a higher height.
    private lastTemplateHeightByAddress: { [address: string]: number } = {};

    constructor(
        private readonly bitcoinRpcService: BitcoinRpcService
    ) {
    }

    // Elektron Net: build a fresh job template for a specific miner payout address.
    // The node-side UTXO attestation hash is bound to the coinbase output the node
    // assumed at template time, so every miner needs its own `getblocktemplate`
    // call with their `coinbaseaddress`. Shared templates can never be used.
    public async buildTemplateFor(coinbaseAddress: string): Promise<IJobTemplate> {
        const blockTemplate = await this.bitcoinRpcService.getBlockTemplate(coinbaseAddress);

        const currentTime = Math.floor(new Date().getTime() / 1000);
        const timestamp = blockTemplate.mintime > currentTime ? blockTemplate.mintime : currentTime;

        const previousHeight = this.lastTemplateHeightByAddress[coinbaseAddress] ?? 0;
        const clearJobs = previousHeight !== blockTemplate.height;
        this.lastTemplateHeightByAddress[coinbaseAddress] = blockTemplate.height;

        const requiredOutputs = (blockTemplate.coinbase_required_outputs ?? []).map(o => ({
            value: o.value,
            scriptPubKey: Buffer.from(o.scriptPubKey, 'hex'),
        }));
        const scriptSigPrefix = blockTemplate.coinbase_script_sig_prefix
            ? Buffer.from(blockTemplate.coinbase_script_sig_prefix, 'hex')
            : undefined;

        const block = new bitcoinjs.Block();
        const transactions = blockTemplate.transactions.map(t => bitcoinjs.Transaction.fromHex(t.data));

        // Placeholder coinbase so the Merkle branch computation has the right shape;
        // the real coinbase is built per-job in MiningJob.
        const tempCoinbaseTx = new bitcoinjs.Transaction();
        tempCoinbaseTx.version = 2;
        tempCoinbaseTx.addInput(Buffer.alloc(32, 0), 0xffffffff, 0xffffffff);
        tempCoinbaseTx.ins[0].witness = [Buffer.alloc(32, 0)];
        transactions.unshift(tempCoinbaseTx);

        const transactionBuffers = transactions.map(tx => tx.getHash(false));

        const merkleTree = merkle(transactionBuffers, bitcoinjs.crypto.hash256);
        const merkleBranches: Buffer[] = merkleProof(merkleTree, transactionBuffers[0]).filter(h => h != null);
        block.merkleRoot = merkleBranches.pop();
        const merkle_branch = merkleBranches.slice(1, merkleBranches.length).map(b => b.toString('hex'));

        block.prevHash = this.convertToLittleEndian(blockTemplate.previousblockhash);
        block.version = blockTemplate.version;
        block.bits = parseInt(blockTemplate.bits, 16);
        block.timestamp = timestamp;
        block.transactions = transactions;
        block.witnessCommit = bitcoinjs.Block.calculateMerkleRoot(transactions, true);

        const id = this.getNextTemplateId();
        this.latestJobTemplateId++;

        const jobTemplate: IJobTemplate = {
            block,
            merkle_branch,
            coinbase_required_outputs: requiredOutputs,
            coinbase_script_sig_prefix: scriptSigPrefix,
            blockData: {
                id,
                creation: new Date().getTime(),
                coinbasevalue: blockTemplate.coinbasevalue,
                networkDifficulty: this.calculateNetworkDifficulty(parseInt(blockTemplate.bits, 16)),
                height: blockTemplate.height,
                clearJobs
            }
        };

        if (clearJobs) {
            // A new tip means every active job is stale (different prev hash / attestation).
            this.blocks = {};
            this.jobs = {};
        } else {
            const now = new Date().getTime();
            for (const templateId in this.blocks) {
                if (now - this.blocks[templateId].blockData.creation > (1000 * 60 * 5)) {
                    delete this.blocks[templateId];
                }
            }
            for (const jobId in this.jobs) {
                if (now - this.jobs[jobId].creation > (1000 * 60 * 5)) {
                    delete this.jobs[jobId];
                }
            }
        }
        this.blocks[id] = jobTemplate;

        return jobTemplate;
    }

    private calculateNetworkDifficulty(nBits: number) {
        const mantissa: number = nBits & 0x007fffff;       // Extract the mantissa from nBits
        const exponent: number = (nBits >> 24) & 0xff;       // Extract the exponent from nBits

        const target: number = mantissa * Math.pow(256, (exponent - 3));   // Calculate the target value

        const maxTarget = Math.pow(2, 208) * 65535; // Easiest target (max_target)
        const difficulty: number = maxTarget / target;    // Calculate the difficulty

        return difficulty;
    }

    private convertToLittleEndian(hash: string): Buffer {
        const bytes = Buffer.from(hash, 'hex');
        Array.prototype.reverse.call(bytes);
        return bytes;
    }

    public getJobTemplateById(jobTemplateId: string): IJobTemplate | null {
        return this.blocks[jobTemplateId];
    }

    public addJob(job: MiningJob) {
        this.jobs[job.jobId] = job;
        this.latestJobId++;
    }

    public getJobById(jobId: string) {
        return this.jobs[jobId];
    }

    public getNextTemplateId() {
        return this.latestJobTemplateId.toString(16);
    }
    public getNextId() {
        return this.latestJobId.toString(16);
    }

}
