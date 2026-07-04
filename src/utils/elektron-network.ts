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

// Regtest variant for local Elektron development chains. Bitcoin uses HRP `bcrt`
// for regtest; Elektron does not document a regtest HRP, so we mirror Bitcoin's
// convention and prefix with `b` (override via NETWORK=bitcoin-regtest if needed).
export const elektronRegtest: bitcoinjs.networks.Network = {
    messagePrefix: '\x18Elektron Signed Message:\n',
    bech32: 'bert',
    bip32: {
        public: 0x043587cf,
        private: 0x04358394,
    },
    pubKeyHash: 0x6f,
    scriptHash: 0xc4,
    wif: 0xef,
};
