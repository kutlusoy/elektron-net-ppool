// 1:1 mirror of mining/miner.py:_build_coinbase_tx (Elektron Net reference miner).
//
// Field-by-field correspondence with the Python source:
//
//   height       = template['height']                  (jobTemplate.blockData.height)
//   prefix_hex   = template['coinbase_script_sig_prefix']
//   script_sig   = bytes.fromhex(prefix_hex)            — NOTHING APPENDED
//   prevout      = bytes(32) + b'\xff\xff\xff\xff'
//   nSequence    = 0xFFFFFFFE  (MAX_SEQUENCE_NONFINAL — required for timelock)
//   vout[0]      = (coinbasevalue, payout scriptPubKey)
//   vout[1..]    = coinbase_required_outputs verbatim, in template order
//   nLockTime    = height - 1                          (Elektron consensus)
//   witness      = single 32-byte zero stack item on vin[0]
//
// The miner.py comment on `script_sig = bytes.fromhex(prefix_hex)` is the
// reason we cannot append an extranonce placeholder here:
//
//   # Use the exact prefix from getblocktemplate so UTXO attestation matches.
//
// Any extra byte in scriptSig changes the coinbase txid; the post-block
// UTXO set then hashes differently from the value baked into
// coinbase_required_outputs[0] and the node rejects with
// bad-utxo-attestation. EXTRANONCE_SIZE = 0 in stratum.constants.ts is
// what keeps this true on the Stratum wire.

import * as bitcoinjs from 'bitcoinjs-lib';

import { IJobTemplate } from '../services/stratum-v1-jobs.service';
import { eResponseMethod } from './enums/eResponseMethod';
import { IMiningNotify } from './stratum-messages/IMiningNotify';
import { ConfigService } from '@nestjs/config';

const MAX_BLOCK_WEIGHT = 4000000;

interface AddressObject {
    address: string;
    percent: number;
}

export class MiningJob {

    private coinbaseTransaction: bitcoinjs.Transaction;
    private coinbasePart1: string;
    private coinbasePart2: string;
    private coinbasePart1Buffer: Buffer;
    private coinbasePart2Buffer: Buffer;
    private merkleBranchBuffers: Buffer[];

    public jobTemplateId: string;
    public networkDifficulty: number;
    public creation: number;

    constructor(
        configService: ConfigService,
        private network: bitcoinjs.networks.Network,
        public jobId: string,
        payoutInformation: AddressObject[],
        jobTemplate: IJobTemplate
    ) {

        this.creation = new Date().getTime();
        this.jobTemplateId = jobTemplate.blockData.id;
        this.merkleBranchBuffers = jobTemplate.merkle_branch.map(branch => Buffer.from(branch, 'hex'));

        // miner.py: height = template['height']
        const height = jobTemplate.blockData.height;

        this.coinbaseTransaction = this.createCoinbaseTransaction(payoutInformation, jobTemplate.blockData.coinbasevalue);

        // miner.py: tx += struct.pack('<I', height - 1)  # nLockTime = height - 1
        this.coinbaseTransaction.locktime = height - 1;

        // miner.py:
        //   prefix_hex = template.get('coinbase_script_sig_prefix')
        //   if prefix_hex:
        //       script_sig = bytes.fromhex(prefix_hex)
        //   else:
        //       script_sig = _script_num(height)
        //       if len(script_sig) < 2: script_sig += bytes([0x00])
        //
        // No extranonce, no padding. The comment in miner.py is exact:
        //   # Use the exact prefix from getblocktemplate so UTXO attestation matches.
        let scriptSig: Buffer;
        if (jobTemplate.coinbase_script_sig_prefix && jobTemplate.coinbase_script_sig_prefix.length > 0) {
            scriptSig = jobTemplate.coinbase_script_sig_prefix;
        } else {
            const heightEncoded = bitcoinjs.script.number.encode(height);
            const heightLengthByte = Buffer.from([heightEncoded.length]);
            scriptSig = Buffer.concat([heightLengthByte, heightEncoded]);
            if (scriptSig.length < 2) {
                scriptSig = Buffer.concat([scriptSig, Buffer.from([0x00])]); // OP_0 — bad-cb-length guard
            }
        }
        this.coinbaseTransaction.ins[0].script = scriptSig;

        // miner.py:
        //   outputs = vout[0] payout, then each entry of coinbase_required_outputs in order.
        //   vout[0] already added in createCoinbaseTransaction; here we append the required_outputs.
        const requiredOutputs = jobTemplate.coinbase_required_outputs ?? [];
        if (requiredOutputs.length > 0) {
            for (const out of requiredOutputs) {
                this.coinbaseTransaction.addOutput(out.scriptPubKey, out.value);
            }
        } else if (jobTemplate.block.witnessCommit) {
            // miner.py fallback: if no required_outputs, build the witness commitment
            // from default_witness_commitment.
            const segwitMagic = Buffer.from('aa21a9ed', 'hex');
            this.coinbaseTransaction.addOutput(
                bitcoinjs.script.compile([bitcoinjs.opcodes.OP_RETURN, Buffer.concat([segwitMagic, jobTemplate.block.witnessCommit])]),
                0,
            );
        }

        if ((this.coinbaseTransaction.weight() + jobTemplate.block.weight()) > MAX_BLOCK_WEIGHT) {
            throw new Error('Block weight exceeds the maximum allowed weight');
        }

        // Stratum wire layout when EXTRANONCE_SIZE = 0 on both sides:
        //
        //   coinbase = coinb1 + "" + "" + ""
        //
        // i.e. coinb1 = the canonical non-witness coinbase, coinb2 = empty.
        // This is bit-identical to miner.py's `tx_no_witness` output.
        //@ts-ignore — __toBuffer() skips the witness section.
        this.coinbasePart1 = this.coinbaseTransaction.__toBuffer().toString('hex');
        this.coinbasePart2 = '';
        this.coinbasePart1Buffer = Buffer.from(this.coinbasePart1, 'hex');
        this.coinbasePart2Buffer = Buffer.alloc(0);
    }

    public cloneCoinbaseTransaction(): bitcoinjs.Transaction {
        return bitcoinjs.Transaction.fromBuffer(this.coinbaseTransaction.toBuffer());
    }

    public buildHeaderBuffer(jobTemplate: IJobTemplate, versionMask: number, nonce: number, _extraNonce: string, _extraNonce2: string, timestamp: number): Buffer {
        // With EXTRANONCE_SIZE = 0 the worker can't change the coinbase, so the
        // hash is precisely the precomputed coinbasePart1Buffer (=tx_no_witness).
        const coinbaseHash = bitcoinjs.crypto.hash256(this.coinbasePart1Buffer);
        const merkleRoot = this.calculateMerkleRootHash(coinbaseHash, this.merkleBranchBuffers);

        let version = jobTemplate.block.version;
        if (versionMask !== undefined && versionMask != 0) {
            version = version ^ versionMask;
        }

        const header = Buffer.alloc(80);
        header.writeInt32LE(version, 0);
        jobTemplate.block.prevHash.copy(header, 4);
        merkleRoot.copy(header, 36);
        header.writeUInt32LE(timestamp, 68);
        header.writeUInt32LE(jobTemplate.block.bits, 72);
        header.writeUInt32LE(nonce, 76);

        return header;
    }

    /**
     * Diagnostic only. Recomputes the 80-byte header as a Stratum-classic
     * worker would, i.e. with `coinbaseSuffix` (typically extranonce1 || extranonce2)
     * appended to the canonical coinbase before hashing. Used to check whether
     * firmwares like NerdMiner V2 splice extranonce1 into the coinbase even
     * when extranonce2_size = 0 — if shares validate at this header but not at
     * `buildHeaderBuffer`, the firmware is doing the classic splice.
     */
    public buildHeaderBufferWithCoinbaseSuffix(
        jobTemplate: IJobTemplate,
        versionMask: number,
        nonce: number,
        coinbaseSuffix: Buffer,
        timestamp: number,
    ): Buffer {
        const splicedCoinbase = coinbaseSuffix.length > 0
            ? Buffer.concat([this.coinbasePart1Buffer, coinbaseSuffix])
            : this.coinbasePart1Buffer;
        return this.assembleHeader(jobTemplate, versionMask, nonce, splicedCoinbase, timestamp);
    }

    /**
     * Diagnostic only. Mirror of `buildHeaderBufferWithCoinbaseSuffix` but
     * prepends `coinbasePrefix` to the canonical coinbase before hashing
     * (covers firmwares that splice at the wrong position).
     */
    public buildHeaderBufferWithCoinbasePrefix(
        jobTemplate: IJobTemplate,
        versionMask: number,
        nonce: number,
        coinbasePrefix: Buffer,
        timestamp: number,
    ): Buffer {
        const splicedCoinbase = coinbasePrefix.length > 0
            ? Buffer.concat([coinbasePrefix, this.coinbasePart1Buffer])
            : this.coinbasePart1Buffer;
        return this.assembleHeader(jobTemplate, versionMask, nonce, splicedCoinbase, timestamp);
    }

    /**
     * Diagnostic only. Reproduces the BIP-style Stratum splice: append
     * `extraBytes` to the END of vin[0].scriptSig (so the scriptSig length
     * byte changes too), then re-serialize the coinbase. This is what
     * spec-compliant Stratum v1 firmwares do with extranonce1+extranonce2.
     * Useful to verify whether a firmware is doing the classical splice
     * at the right position inside the tx rather than just appending bytes
     * past the end of the tx.
     */
    public buildHeaderBufferWithScriptSigSplice(
        jobTemplate: IJobTemplate,
        versionMask: number,
        nonce: number,
        extraBytes: Buffer,
        timestamp: number,
    ): Buffer {
        // Clone the coinbase tx, append extraBytes to scriptSig, re-encode.
        const cloned = bitcoinjs.Transaction.fromBuffer(this.coinbaseTransaction.toBuffer());
        cloned.ins[0].script = Buffer.concat([cloned.ins[0].script, extraBytes]);
        //@ts-ignore — __toBuffer() skips the witness section, matching tx_no_witness.
        const splicedCoinbase: Buffer = cloned.__toBuffer();
        return this.assembleHeader(jobTemplate, versionMask, nonce, splicedCoinbase, timestamp);
    }

    private assembleHeader(
        jobTemplate: IJobTemplate,
        versionMask: number,
        nonce: number,
        coinbaseSerialized: Buffer,
        timestamp: number,
    ): Buffer {
        const coinbaseHash = bitcoinjs.crypto.hash256(coinbaseSerialized);
        const merkleRoot = this.calculateMerkleRootHash(coinbaseHash, this.merkleBranchBuffers);

        let version = jobTemplate.block.version;
        if (versionMask !== undefined && versionMask != 0) {
            version = version ^ versionMask;
        }

        const header = Buffer.alloc(80);
        header.writeInt32LE(version, 0);
        jobTemplate.block.prevHash.copy(header, 4);
        merkleRoot.copy(header, 36);
        header.writeUInt32LE(timestamp, 68);
        header.writeUInt32LE(jobTemplate.block.bits, 72);
        header.writeUInt32LE(nonce, 76);

        return header;
    }

    public copyAndUpdateBlock(jobTemplate: IJobTemplate, versionMask: number, nonce: number, _extraNonce: string, _extraNonce2: string, timestamp: number): bitcoinjs.Block {

        const testBlock = Object.assign(new bitcoinjs.Block(), jobTemplate.block);
        testBlock.transactions = jobTemplate.block.transactions.map(tx => {
            return Object.assign(new bitcoinjs.Transaction(), tx);
        });

        // Coinbase is the canonical miner.py-style tx — scriptSig untouched,
        // locktime baked in, required_outputs in template order. We submit it
        // verbatim, which is what miner.py does too.
        testBlock.transactions[0] = this.cloneCoinbaseTransaction();

        testBlock.nonce = nonce;
        if (versionMask !== undefined && versionMask != 0) {
            testBlock.version = (testBlock.version ^ versionMask);
        }

        testBlock.merkleRoot = this.calculateMerkleRootHash(testBlock.transactions[0].getHash(false), this.merkleBranchBuffers);
        testBlock.timestamp = timestamp;

        return testBlock;
    }


    private calculateMerkleRootHash(newRoot: Buffer, merkleBranches: Buffer[]): Buffer {

        const bothMerkles = Buffer.alloc(64);

        bothMerkles.set(newRoot);

        for (let i = 0; i < merkleBranches.length; i++) {
            bothMerkles.set(merkleBranches[i], 32);
            newRoot = bitcoinjs.crypto.hash256(bothMerkles);
            bothMerkles.set(newRoot);
        }

        return bothMerkles.subarray(0, 32)
    }


    private createCoinbaseTransaction(addresses: AddressObject[], reward: number): bitcoinjs.Transaction {
        // miner.py:
        //   tx = struct.pack('<i', 2)                       # version 2
        //   inputs = bytes(32) + struct.pack('<I', 0xFFFFFFFF)
        //          + scriptSig_with_compactsize
        //          + struct.pack('<I', 0xFFFFFFFE)          # nSequence
        //   outputs = struct.pack('<Q', coinbasevalue)
        //           + scriptPubKey_with_compactsize         # vout[0] payout
        //   coinbase witness = single 32-byte zero item     # BIP141 reserved
        const coinbaseTransaction = new bitcoinjs.Transaction();
        coinbaseTransaction.version = 2;
        coinbaseTransaction.addInput(Buffer.alloc(32, 0), 0xffffffff, 0xfffffffe);

        // Single payout: doc §5.5 forbids dev/pool-fee splits — attestation is
        // pinned to a single payout output.
        let rewardBalance = reward;
        addresses.forEach(recipientAddress => {
            const amount = Math.floor((recipientAddress.percent / 100) * reward);
            rewardBalance -= amount;
            coinbaseTransaction.addOutput(this.getPaymentScript(recipientAddress.address), amount);
        });
        coinbaseTransaction.outs[0].value += rewardBalance;

        coinbaseTransaction.ins[0].witness = [Buffer.alloc(32, 0)];

        return coinbaseTransaction;
    }

    private getPaymentScript(address: string): Buffer {
        try {
            return bitcoinjs.address.toOutputScript(address, this.network);
        } catch (e) {
            console.warn(`Invalid payout address ${address}: ${e.message ?? e}`);
            return Buffer.alloc(0);
        }
    }

    public response(jobTemplate: IJobTemplate): string {

        const job: IMiningNotify = {
            id: null,
            method: eResponseMethod.MINING_NOTIFY,
            params: [
                this.jobId,
                this.swapEndianWords(jobTemplate.block.prevHash).toString('hex'),
                this.coinbasePart1,
                this.coinbasePart2,
                jobTemplate.merkle_branch,
                jobTemplate.block.version.toString(16),
                jobTemplate.block.bits.toString(16),
                jobTemplate.block.timestamp.toString(16),
                jobTemplate.blockData.clearJobs
            ]
        };

        return JSON.stringify(job) + '\n';
    }


    private swapEndianWords(buffer: Buffer): Buffer {
        const swappedBuffer = Buffer.alloc(buffer.length);

        for (let i = 0; i < buffer.length; i += 4) {
            swappedBuffer[i] = buffer[i + 3];
            swappedBuffer[i + 1] = buffer[i + 2];
            swappedBuffer[i + 2] = buffer[i + 1];
            swappedBuffer[i + 3] = buffer[i];
        }

        return swappedBuffer;
    }


}
