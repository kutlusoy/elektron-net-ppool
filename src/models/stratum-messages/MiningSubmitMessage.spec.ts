import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { MiningSubmitMessage } from './MiningSubmitMessage';

describe('MiningSubmitMessage', () => {

    describe('test message parsing', () => {

        // EXTRANONCE2_SIZE_BYTES = 0 means the pool does not feed
        // extranonce2 into the canonical coinbase. The parser still records
        // whatever the firmware sent so that diagnostics
        // (DIAGNOSTIC_SHARE_LOGGING_MODES) can compare against alternate
        // header-reconstruction hypotheses (e.g. NerdMiner_v2 hardcoding
        // "00000001" via utils.cpp:222-226).
        const MINING_SUBMIT_MESSAGE = ' {"id": 5, "method": "mining.submit", "params": ["tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.bitaxe3", "1", "", "64b1f10f", "2402812d", "00006000"]}'

        const message = plainToInstance(
            MiningSubmitMessage,
            JSON.parse(MINING_SUBMIT_MESSAGE),
        );

        it('should parse message', () => {
            expect(message.id).toEqual(5);
            expect(message.userId).toEqual('tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.bitaxe3');
            expect(message.jobId).toEqual('1');
            expect(message.extraNonce2).toEqual('');
            expect(message.ntime).toEqual('64b1f10f');
            expect(message.nonce).toEqual('2402812d');
            expect(message.versionMask).toEqual('00006000');
        });

        it('should validate empty extranonce2 submissions', async () => {
            const errors = await validate(message);
            expect(errors).toEqual([]);
        });

        it('should preserve any firmware-supplied extranonce2 (e.g. NerdMiner "00000001")', async () => {
            // NerdMiner_v2 v1.8.3 hardcodes extranonce2 = "00000001" when the
            // pool advertises extranonce2_size = 0 (utils.cpp:222-226 falls
            // through to the else branch). The pool never uses this value in
            // its canonical coinbase, but the parser must still surface it so
            // the diagnostic share-validation modes can detect the firmware
            // behaviour.
            const submissionWithExtra = plainToInstance(
                MiningSubmitMessage,
                JSON.parse(' {"id": 5, "method": "mining.submit", "params": ["tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.bitaxe3", "1", "00000001", "64b1f10f", "2402812d", "00006000"]}'),
            );

            expect(submissionWithExtra.extraNonce2).toEqual('00000001');
            const errors = await validate(submissionWithExtra);
            expect(errors).toEqual([]);
        });
    });


});
