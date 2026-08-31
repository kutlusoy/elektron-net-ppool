import { ConfigService } from '@nestjs/config';
import * as bitcoinjs from 'bitcoinjs-lib';

// Elektron Net network parameters.
// Bech32 HRP `be` is the only mandatory deviation from Bitcoin documented in
// doc-elektron/BITCOIN_CORE_DIFF.md (§7). pubKeyHash/scriptHash/wif are kept
// at the Bitcoin defaults because §5.4 of the diff notes that address logic is
// unchanged. If a future Elektron release adjusts these prefixes, update here.
export const elektronMainnet: bitcoinjs.networks.Network = {
    messagePrefix: '\x18Elektron Signed Message:\n',
    bech32: 'be',
    bip32: {
        public: 0x0488b21e,
        private: 0x0488ade4,
    },
    pubKeyHash: 0x00,
    scriptHash: 0x05,
    wif: 0x80,
};

// Regtest variant for local Elektron development chains. The node's own
// regtest chain params (src/kernel/chainparams.cpp, CRegTestParams) hardcode
// `bech32_hrp = "bcrt"` -- the standard Bitcoin regtest HRP, unchanged by
// Elektron. This MUST match that value exactly: any other HRP here makes the
// pool reject addresses the node's own wallet generates (and vice versa).
export const elektronRegtest: bitcoinjs.networks.Network = {
    messagePrefix: '\x18Elektron Signed Message:\n',
    bech32: 'bcrt',
    bip32: {
        public: 0x043587cf,
        private: 0x04358394,
    },
    pubKeyHash: 0x6f,
    scriptHash: 0xc4,
    wif: 0xef,
};

// Same NETWORK env var -> bitcoinjs network mapping used by
// BitcoinAddressValidator/StratumV1Client, factored out so new call sites
// (e.g. TelegramService) don't have to duplicate it or fall back to a
// generic address-validation library that doesn't know Elektron Net's
// custom bech32 HRP.
export function resolveConfiguredNetwork(configService: ConfigService): bitcoinjs.networks.Network | null {
    const networkConfig = configService.get<string>('NETWORK');

    switch (networkConfig) {
        case 'mainnet':
            return elektronMainnet;
        case 'regtest':
            return elektronRegtest;
        case 'bitcoin-mainnet':
            return bitcoinjs.networks.bitcoin;
        case 'bitcoin-testnet':
            return bitcoinjs.networks.testnet;
        case 'bitcoin-regtest':
            return bitcoinjs.networks.regtest;
        default:
            return null;
    }
}
