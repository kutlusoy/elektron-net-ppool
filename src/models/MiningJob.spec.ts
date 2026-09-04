import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import * as bitcoinjs from 'bitcoinjs-lib';
import { BehaviorSubject } from 'rxjs';

import { MockRecording1 } from '../../test/models/MockRecording1';
import { IMiningInfo } from './bitcoin-rpc/IMiningInfo';
import { IJobTemplate, StratumV1JobsService } from '../services/stratum-v1-jobs.service';
import { MiningJob } from './MiningJob';

describe('MiningJob (miner.py-style header-only)', () => {
    let moduleRef: TestingModule;
    let configService: ConfigService;
    let jobTemplate: IJobTemplate;

    beforeAll(async () => {
        moduleRef = await Test.createTestingModule({
            providers: [
                {
                    provide: ConfigService,
                    useValue: {
                        get: jest.fn(() => null)
                    }
                }
            ],
        }).compile();
        configService = moduleRef.get<ConfigService>(ConfigService);
    });

    describe('canonical coinbase (no extranonce in scriptSig)', () => {
        let job: MiningJob;

        beforeEach(async () => {
            jest.useFakeTimers();
            jest.setSystemTime(new Date(parseInt(MockRecording1.TIME, 16) * 1000));
            configService.get = jest.fn(() => null);

            const miningInfo$ = new BehaviorSubject<IMiningInfo>({
                blocks: MockRecording1.BLOCK_TEMPLATE.height
            } as IMiningInfo);
            const bitcoinRpcService = {
                newBlock$: miningInfo$.asObservable(),
                getBlockTemplate: jest.fn().mockResolvedValue(MockRecording1.BLOCK_TEMPLATE)
            };
            jest.spyOn(console, 'log').mockImplementation(() => undefined);

            const jobsService = new StratumV1JobsService(bitcoinRpcService as any);
            jobTemplate = await jobsService.buildTemplateFor('tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4');
            job = new MiningJob(
                configService,
                bitcoinjs.networks.testnet,
                '1',
                [{ address: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4', percent: 100 }],
                jobTemplate
            );
        });

        afterEach(() => {
            jest.restoreAllMocks();
            jest.useRealTimers();
        });

        it('should set nLockTime = height - 1 (Elektron Net consensus)', () => {
            // miner.py: tx += struct.pack('<I', height - 1)
            const cb = job.cloneCoinbaseTransaction();
            expect(cb.locktime).toBe(jobTemplate.blockData.height - 1);
        });

        it('should set scriptSig to exactly the GBT prefix - no extranonce appended', () => {
            // miner.py:
            //   prefix_hex = template.get('coinbase_script_sig_prefix')
            //   script_sig = bytes.fromhex(prefix_hex)
            //
            // When the template omits the prefix (older mocks), MiningJob
            // falls back to encoding the BIP34 height itself - same as
            // miner.py's `_script_num(height)` branch. Either way the
            // scriptSig must NOT contain any extranonce bytes.
            const cb = job.cloneCoinbaseTransaction();
            const expected = jobTemplate.coinbase_script_sig_prefix && jobTemplate.coinbase_script_sig_prefix.length > 0
                ? jobTemplate.coinbase_script_sig_prefix
                : (() => {
                    const e = bitcoinjs.script.number.encode(jobTemplate.blockData.height);
                    const len = Buffer.from([e.length]);
                    let s = Buffer.concat([len, e]);
                    if (s.length < 2) s = Buffer.concat([s, Buffer.from([0x00])]);
                    return s;
                })();
            expect(cb.ins[0].script.equals(expected)).toBe(true);
        });

        it('should use nSequence = 0xfffffffe', () => {
            const cb = job.cloneCoinbaseTransaction();
            expect(cb.ins[0].sequence).toBe(0xfffffffe);
        });

        it('should put coinbase_required_outputs verbatim at vout[1..N] in template order', () => {
            const cb = job.cloneCoinbaseTransaction();
            const required = jobTemplate.coinbase_required_outputs ?? [];
            if (required.length > 0) {
                // vout[0] = payout, vout[1..N] = required_outputs in order.
                expect(cb.outs.length).toBe(1 + required.length);
                required.forEach((req, idx) => {
                    expect(cb.outs[1 + idx].script.equals(req.scriptPubKey)).toBe(true);
                    expect(cb.outs[1 + idx].value).toBe(req.value);
                });
            } else {
                // Fallback path (this mock template does not carry
                // required_outputs but does carry default_witness_commitment):
                // miner.py adds the witness commitment as vout[1].
                expect(cb.outs.length).toBe(2);
                expect(cb.outs[1].value).toBe(0);
            }
        });

        it('should attach a single 32-byte zero witness item on vin[0]', () => {
            const cb = job.cloneCoinbaseTransaction();
            expect(cb.ins[0].witness.length).toBe(1);
            expect(cb.ins[0].witness[0].length).toBe(32);
            expect(cb.ins[0].witness[0].equals(Buffer.alloc(32, 0))).toBe(true);
        });

        it('should split the non-witness coinbase into coinb1/coinb2 at the scriptSig boundary', () => {
            // EXTRANONCE_SIZE = 0 on both sides ⇒ worker has nothing to insert,
            // but coinb2 is NOT empty: standard Stratum V1 clients (ESP-Miner
            // included) read nSequence/outputs/nLockTime from coinb2 and fail
            // to parse the job if it is empty.
            const notify = JSON.parse(job.response(jobTemplate));
            const coinb1 = notify.params[2];
            const coinb2 = notify.params[3];
            expect(coinb2.length).toBeGreaterThan(0);

            // coinb1 + coinb2 together must parse as a valid coinbase tx with the right locktime.
            const reconstructed = bitcoinjs.Transaction.fromHex(coinb1 + coinb2);
            expect(reconstructed.locktime).toBe(jobTemplate.blockData.height - 1);
            expect(reconstructed.ins[0].sequence).toBe(0xfffffffe);
        });

        it('should reassemble coinb1+coinb2 to exactly the full non-witness coinbase transaction', () => {
            // Safety property the UTXO attestation depends on: splitting the
            // wire fields differently must not change a single byte.
            const notify = JSON.parse(job.response(jobTemplate));
            const coinb1 = notify.params[2];
            const coinb2 = notify.params[3];
            const reassembled = Buffer.concat([Buffer.from(coinb1, 'hex'), Buffer.from(coinb2, 'hex')]);

            const coinbaseTx = (job as any).coinbaseTransaction as bitcoinjs.Transaction;
            // @ts-ignore - __toBuffer() skips the witness section, matching coinb1/coinb2.
            const fullTxBuffer: Buffer = coinbaseTx.__toBuffer();

            expect(reassembled.equals(fullTxBuffer)).toBe(true);
        });

        it('should end coinb1 exactly at the scriptSig boundary and start coinb2 with nSequence', () => {
            const cb = job.cloneCoinbaseTransaction();
            const scriptSigLength = cb.ins[0].script.length;
            // version(4) + input count(1) + prevout hash+index(36) + scriptSig length byte(1) + scriptSig
            const expectedSplitOffset = 41 + 1 + scriptSigLength;

            const notify = JSON.parse(job.response(jobTemplate));
            const coinb1: string = notify.params[2];
            const coinb2: string = notify.params[3];

            expect(coinb1.length / 2).toBe(expectedSplitOffset);
            // MAX_SEQUENCE_NONFINAL = 0xFFFFFFFE, little-endian on the wire.
            expect(coinb2.substring(0, 8)).toBe('feffffff');
        });

        it('should compute buildHeaderBuffer merkle root from the full reassembled coinbase, not coinb1 alone', () => {
            const versionMask = parseInt('00002000', 16);
            const nonce = parseInt('ed460d91', 16);
            const timestamp = parseInt(MockRecording1.TIME, 16);

            const header = job.buildHeaderBuffer(jobTemplate, versionMask, nonce, '', '', timestamp);

            const coinbaseTx = (job as any).coinbaseTransaction as bitcoinjs.Transaction;
            // @ts-ignore - __toBuffer() skips the witness section, matching coinb1/coinb2.
            const fullTxBuffer: Buffer = coinbaseTx.__toBuffer();
            const expectedCoinbaseHash = bitcoinjs.crypto.hash256(fullTxBuffer);

            let root = expectedCoinbaseHash;
            const bothMerkles = Buffer.alloc(64);
            bothMerkles.set(root);
            for (const branch of jobTemplate.merkle_branch) {
                bothMerkles.set(Buffer.from(branch, 'hex'), 32);
                root = bitcoinjs.crypto.hash256(bothMerkles);
                bothMerkles.set(root);
            }
            const expectedMerkleRoot = bothMerkles.subarray(0, 32);

            expect(header.subarray(36, 68).equals(expectedMerkleRoot)).toBe(true);
        });

        it('should build the same header via buildHeaderBuffer and copyAndUpdateBlock', () => {
            const versionMask = parseInt('00002000', 16);
            const nonce = parseInt('ed460d91', 16);
            const timestamp = parseInt(MockRecording1.TIME, 16);

            const updatedBlock = job.copyAndUpdateBlock(jobTemplate, versionMask, nonce, '', '', timestamp);
            const fastHeader = job.buildHeaderBuffer(jobTemplate, versionMask, nonce, '', '', timestamp);

            expect(fastHeader.equals(updatedBlock.toBuffer(true))).toBe(true);
        });

        it('should leave block version unchanged without a version mask', () => {
            const updatedBlock = job.copyAndUpdateBlock(jobTemplate, 0, parseInt('ed460d91', 16), '', '', parseInt(MockRecording1.TIME, 16));
            expect(updatedBlock.version).toBe(jobTemplate.block.version);
        });

        it('should not add any pool identity output when POOL_IDENTIFIER/POOL_URL are unset', () => {
            // Regression guard: the default test configService.get() returns
            // null for every key, so today's coinbase shape must be
            // byte-for-byte unchanged (this is also asserted by the
            // vout[1..N] test above, which checks an exact outs.length).
            const cb = job.cloneCoinbaseTransaction();
            const decompiled = cb.outs.map(o => bitcoinjs.script.decompile(o.script));
            const hasMagic = (magic: Buffer) => decompiled.some(ops =>
                Array.isArray(ops) && ops.length === 2 && Buffer.isBuffer(ops[1]) && (ops[1] as Buffer).subarray(0, 4).equals(magic));
            expect(hasMagic(Buffer.from('EPNM', 'ascii'))).toBe(false);
            expect(hasMagic(Buffer.from('EPUR', 'ascii'))).toBe(false);
        });
    });

    describe('pool identity outputs (doc-elektron/guideline-pool-identity-op-return.md)', () => {
        const EPNM = Buffer.from('EPNM', 'ascii');
        const EPUR = Buffer.from('EPUR', 'ascii');
        const WITNESS_COMMIT_MAGIC = Buffer.from('aa21a9ed', 'hex');

        beforeEach(() => {
            jest.useFakeTimers();
            jest.setSystemTime(new Date(parseInt(MockRecording1.TIME, 16) * 1000));
            jest.spyOn(console, 'log').mockImplementation(() => undefined);
        });

        afterEach(() => {
            jest.restoreAllMocks();
            jest.useRealTimers();
        });

        async function buildJobWithConfig(configValues: Record<string, string | null>): Promise<{ job: MiningJob; jobTemplate: IJobTemplate }> {
            const testConfigService = { get: jest.fn((key: string) => configValues[key] ?? null) } as unknown as ConfigService;

            const miningInfo$ = new BehaviorSubject<IMiningInfo>({
                blocks: MockRecording1.BLOCK_TEMPLATE.height
            } as IMiningInfo);
            const bitcoinRpcService = {
                newBlock$: miningInfo$.asObservable(),
                getBlockTemplate: jest.fn().mockResolvedValue(MockRecording1.BLOCK_TEMPLATE)
            };

            const jobsService = new StratumV1JobsService(bitcoinRpcService as any);
            const template = await jobsService.buildTemplateFor('tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4');
            const job = new MiningJob(
                testConfigService,
                bitcoinjs.networks.testnet,
                '1',
                [{ address: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4', percent: 100 }],
                template
            );
            return { job, jobTemplate: template };
        }

        function singlePushMagicAndPayload(script: Buffer): { magic: Buffer; payload: Buffer } | null {
            const ops = bitcoinjs.script.decompile(script);
            if (!Array.isArray(ops) || ops.length !== 2 || ops[0] !== bitcoinjs.opcodes.OP_RETURN || !Buffer.isBuffer(ops[1])) {
                return null;
            }
            const push = ops[1] as Buffer;
            return { magic: push.subarray(0, 4), payload: push.subarray(4) };
        }

        it('appends both outputs, last, single-push, when POOL_IDENTIFIER and POOL_URL are both set', async () => {
            const { job, jobTemplate } = await buildJobWithConfig({
                POOL_IDENTIFIER: 'MeinPool',
                POOL_URL: 'https://meinpool.example'
            });
            const cb = job.cloneCoinbaseTransaction();
            const required = jobTemplate.coinbase_required_outputs ?? [];
            const baseCount = required.length > 0 ? 1 + required.length : 2; // payout + required, or payout + witness-commit fallback

            expect(cb.outs.length).toBe(baseCount + 2);

            const nameOut = singlePushMagicAndPayload(cb.outs[baseCount].script);
            const urlOut = singlePushMagicAndPayload(cb.outs[baseCount + 1].script);

            expect(nameOut).not.toBeNull();
            expect(urlOut).not.toBeNull();
            expect(nameOut.magic.equals(EPNM)).toBe(true);
            expect(nameOut.payload.toString('utf8')).toBe('MeinPool');
            expect(urlOut.magic.equals(EPUR)).toBe(true);
            expect(urlOut.payload.toString('utf8')).toBe('https://meinpool.example');
            expect(cb.outs[baseCount].value).toBe(0);
            expect(cb.outs[baseCount + 1].value).toBe(0);
        });

        it('appends only the name output when POOL_URL is unset', async () => {
            const { job, jobTemplate } = await buildJobWithConfig({ POOL_IDENTIFIER: 'MeinPool' });
            const cb = job.cloneCoinbaseTransaction();
            const required = jobTemplate.coinbase_required_outputs ?? [];
            const baseCount = required.length > 0 ? 1 + required.length : 2;

            expect(cb.outs.length).toBe(baseCount + 1);
            const nameOut = singlePushMagicAndPayload(cb.outs[baseCount].script);
            expect(nameOut.magic.equals(EPNM)).toBe(true);
        });

        it('appends only the URL output when POOL_IDENTIFIER is unset', async () => {
            const { job, jobTemplate } = await buildJobWithConfig({ POOL_URL: 'https://meinpool.example' });
            const cb = job.cloneCoinbaseTransaction();
            const required = jobTemplate.coinbase_required_outputs ?? [];
            const baseCount = required.length > 0 ? 1 + required.length : 2;

            expect(cb.outs.length).toBe(baseCount + 1);
            const urlOut = singlePushMagicAndPayload(cb.outs[baseCount].script);
            expect(urlOut.magic.equals(EPUR)).toBe(true);
        });

        it('truncates on a UTF-8 code-point boundary at 64 bytes and never produces a witness-commitment-shaped push', async () => {
            // "é" is 2 bytes in UTF-8 -- 40 repeats = 80 bytes, over the cap,
            // so the sanitizer must cut on a whole-character boundary.
            const longName = 'é'.repeat(40);
            const { job } = await buildJobWithConfig({ POOL_IDENTIFIER: longName });
            const cb = job.cloneCoinbaseTransaction();
            const nameOutput = cb.outs[cb.outs.length - 1];
            const decoded = singlePushMagicAndPayload(nameOutput.script);

            expect(decoded.magic.equals(EPNM)).toBe(true);
            expect(decoded.payload.length).toBeLessThanOrEqual(64);
            // Must decode cleanly with no replacement characters (no split multi-byte char).
            expect(decoded.payload.toString('utf8')).not.toContain('�');

            // Structural guarantee from Section 3/4 of the guideline: this
            // push is 4 (magic) + <=64 bytes, i.e. never the witness
            // commitment's exact 36-byte push, and its first bytes are never
            // the commitment magic.
            const fullPush = Buffer.concat([decoded.magic, decoded.payload]);
            expect(fullPush.length).not.toBe(36);
            expect(fullPush.subarray(0, 4).equals(WITNESS_COMMIT_MAGIC.subarray(0, 4))).toBe(false);
        });

        it('never emits a two-push output (would risk being read as the UTXO attestation)', async () => {
            const { job } = await buildJobWithConfig({
                POOL_IDENTIFIER: 'MeinPool',
                POOL_URL: 'https://meinpool.example'
            });
            const cb = job.cloneCoinbaseTransaction();
            const lastTwo = cb.outs.slice(-2);
            for (const out of lastTwo) {
                const ops = bitcoinjs.script.decompile(out.script);
                expect(Array.isArray(ops) && ops.length).toBe(2); // [OP_RETURN, <one push>], never three ops (two pushes)
            }
        });
    });
});
