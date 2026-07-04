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

        it('should set scriptSig to exactly the GBT prefix — no extranonce appended', () => {
            // miner.py:
            //   prefix_hex = template.get('coinbase_script_sig_prefix')
            //   script_sig = bytes.fromhex(prefix_hex)
            //
            // When the template omits the prefix (older mocks), MiningJob
            // falls back to encoding the BIP34 height itself — same as
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

        it('should send the full non-witness coinbase as coinb1, with coinb2 empty', () => {
            // EXTRANONCE_SIZE = 0 on both sides ⇒ worker has nothing to insert.
            const notify = JSON.parse(job.response(jobTemplate));
            const coinb1 = notify.params[2];
            const coinb2 = notify.params[3];
            expect(coinb2).toBe('');

            // coinb1 alone must parse as a valid coinbase tx with the right locktime.
            const reconstructed = bitcoinjs.Transaction.fromHex(coinb1);
            expect(reconstructed.locktime).toBe(jobTemplate.blockData.height - 1);
            expect(reconstructed.ins[0].sequence).toBe(0xfffffffe);
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
    });
});
