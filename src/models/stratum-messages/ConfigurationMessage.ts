import { IsArray } from 'class-validator';

import { eRequestMethod } from '../enums/eRequestMethod';
import { StratumBaseMessage } from './StratumBaseMessage';

export class ConfigurationMessage extends StratumBaseMessage {

    @IsArray()
    params: string[];

    constructor() {
        super();
        this.method = eRequestMethod.CONFIGURE;
    }

    public response() {
        return {
            id: this.id,
            error: null,
            result: {
                'version-rolling': true,
                // Bits 13-16 (0x0001e000) are reserved for the pool's own
                // BIP320 work rotation (see StratumV1Client.sendNewMiningJob);
                // the miner is only allowed the remaining bits of the
                // standard 1fffe000 range.
                'version-rolling.mask': '1ffe0000'
            },
        };
    }
}