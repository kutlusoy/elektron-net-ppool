import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bitcoinjs from 'bitcoinjs-lib';
import { registerDecorator, ValidationOptions, ValidatorConstraint, ValidatorConstraintInterface } from 'class-validator';

import { elektronMainnet, elektronRegtest } from '../../utils/elektron-network';


@ValidatorConstraint({ name: 'bitcoinAddress', async: false })
@Injectable()
export class BitcoinAddressValidator implements ValidatorConstraintInterface {

    constructor(
        private configService: ConfigService
    ) { }

    validate(value: string): boolean {
        const networkConfig = this.configService.get<string>('NETWORK');
        let network: bitcoinjs.networks.Network;

        if (networkConfig === 'mainnet') {
            network = elektronMainnet;
        } else if (networkConfig === 'regtest') {
            network = elektronRegtest;
        } else if (networkConfig === 'bitcoin-mainnet') {
            network = bitcoinjs.networks.bitcoin;
        } else if (networkConfig === 'bitcoin-testnet') {
            network = bitcoinjs.networks.testnet;
        } else if (networkConfig === 'bitcoin-regtest') {
            network = bitcoinjs.networks.regtest;
        } else {
            return false;
        }

        try {
            bitcoinjs.address.toOutputScript(value, network);
            return true;
        } catch {
            return false;
        }
    }

    defaultMessage(): string {
        return 'Must be a valid address for the configured network';
    }
}

export function IsBitcoinAddress(validationOptions?: ValidationOptions) {
    return function (object: Object, propertyName: string) {
        registerDecorator({
            name: 'isBitcoinAddress',
            target: object.constructor,
            propertyName: propertyName,
            constraints: [],
            options: validationOptions,
            validator: BitcoinAddressValidator,
        });
    };
}
