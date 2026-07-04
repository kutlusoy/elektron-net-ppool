import { Expose, Transform } from 'class-transformer';
import { IsArray, IsString, MaxLength } from 'class-validator';

import { eRequestMethod } from '../enums/eRequestMethod';
import { EXTRANONCE2_SIZE_BYTES } from '../stratum.constants';
import { StratumBaseMessage } from './StratumBaseMessage';

export class SubscriptionMessage extends StratumBaseMessage {


    @IsArray()
    params: string[];

    @Expose()
    @IsString()
    @MaxLength(128)
    @Transform(({ value, key, obj, type }) => {
        return obj?.params?.[0] == null ? 'unknown' : SubscriptionMessage.refineUserAgent(obj.params[0]);
    })
    public userAgent: string;

    constructor() {
        super();
        this.method = eRequestMethod.SUBSCRIBE;
    }

    public response(clientId: string, hobbyMode: boolean = false) {
        // miner.py-equivalent Stratum wiring: EXTRANONCE2_SIZE_BYTES = 0 so the
        // worker iterates nothing and cannot splice anything into the coinbase.
        //
        // The `extranonce1` slot on the wire is mode-dependent:
        //
        // - hobbyMode = false (default, compliant Stratum miners — Bitaxe with
        //   ESP-Miner, Antminer, Whatsminer, etc.): send empty string. These
        //   firmwares compute coinbase = coinb1 + "" + "" + coinb2 = canonical,
        //   so the merkle root matches the pool's and shares validate cleanly.
        //
        // - hobbyMode = true (NerdMiner_v2 family): send `clientId` as a
        //   non-empty extranonce1 so the firmware does not abort the session
        //   (NerdMiner aborts on empty extranonce1, see stratum.cpp:78-83 in
        //   BitMaker-hub/NerdMiner_v2). The firmware then splices this
        //   extranonce1 (plus a hardcoded "00000001" extranonce2 from
        //   utils.cpp:216-226) into its coinbase, so the resulting merkle root
        //   diverges from the pool's canonical. The connection stays up but
        //   shares cannot be validated — until the firmware is patched.
        //
        // In both modes `clientId` is used as the mining.notify channel tag.
        const extranonce1 = hobbyMode ? clientId : '';
        return {
            id: this.id,
            error: null,
            result: [
                [
                    ['mining.notify', clientId]
                ],
                extranonce1,
                EXTRANONCE2_SIZE_BYTES
            ]
        }


    }

    public static refineUserAgent(userAgent: string): string {
        userAgent = userAgent.split(' ')[0].split('/')[0].split('V')[0].split('-')[0];

        if (userAgent.includes('bosminer') || userAgent.includes('bOS')) {
            userAgent = 'Braiins OS';
        } else if (userAgent.includes('cpuminer')) {
            userAgent = 'cpuminer';
        }
        return userAgent;
    }
}
