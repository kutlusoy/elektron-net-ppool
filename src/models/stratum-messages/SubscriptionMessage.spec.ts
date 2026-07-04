import { plainToInstance } from 'class-transformer';

import { SubscriptionMessage } from './SubscriptionMessage';

describe('SubscriptionMessage', () => {
    it('should parse and refine known user agents', () => {
        const bosminer = plainToInstance(
            SubscriptionMessage,
            JSON.parse('{"id":1,"method":"mining.subscribe","params":["bosminer/23.08"]}')
        );
        const cpuminer = plainToInstance(
            SubscriptionMessage,
            JSON.parse('{"id":1,"method":"mining.subscribe","params":["cpuminer-opt/1.0"]}')
        );

        expect(bosminer.userAgent).toBe('Braiins OS');
        expect(cpuminer.userAgent).toBe('cpuminer');
    });

    it('should default missing user agents to unknown', () => {
        const message = plainToInstance(
            SubscriptionMessage,
            JSON.parse('{"id":1,"method":"mining.subscribe","params":[]}')
        );

        expect(message.userAgent).toBe('unknown');
    });

    it('should respond with empty extranonce1 in NORMAL mode (miner.py compatible, works for Bitaxe / Antminer)', () => {
        // Default NORMAL mode: extranonce1 = "" and extranonce2_size = 0 means
        // a compliant firmware computes coinbase = coinb1 + "" + "" + coinb2 =
        // canonical, matching the pool's submit path and the miner.py
        // reference. UTXO attestation is preserved.
        const message = plainToInstance(
            SubscriptionMessage,
            JSON.parse('{"id":1,"method":"mining.subscribe","params":["bitaxe v2.2"]}')
        );

        expect(message.response('57a6f098', false)).toEqual({
            id: 1,
            error: null,
            result: [
                [['mining.notify', '57a6f098']],
                '',
                0
            ]
        });
    });

    it('should respond with the session id as extranonce1 in HOBBY mode (NerdMiner-compat)', () => {
        // HOBBY mode: extranonce1 = clientId (non-empty) is sent so
        // NerdMiner_v2 firmware does not abort the session on empty
        // extranonce1. Shares from these sessions cannot validate against the
        // pool's canonical coinbase (the firmware splices extranonce1 and a
        // hardcoded "00000001" extranonce2) but the connection stays open and
        // detection / stats remain possible. See SubscriptionMessage.ts for
        // the full reasoning.
        const message = plainToInstance(
            SubscriptionMessage,
            JSON.parse('{"id":1,"method":"mining.subscribe","params":["NerdMinerV2/1.8.3"]}')
        );

        expect(message.response('57a6f098', true)).toEqual({
            id: 1,
            error: null,
            result: [
                [['mining.notify', '57a6f098']],
                '57a6f098',
                0
            ]
        });
    });
});
