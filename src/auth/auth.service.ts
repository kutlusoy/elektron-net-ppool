import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bitcoinMessage from 'bitcoinjs-message';

import { BitcoinRpcService } from '../services/bitcoin-rpc.service';
import { AuthChallengeStore } from './auth-challenge.store';

const JWT_EXPIRES_IN = '24h';

export interface IJwtPayload {
    sub: string; // miner address
}

@Injectable()
export class AuthService {

    constructor(
        private readonly challengeStore: AuthChallengeStore,
        private readonly jwtService: JwtService,
        private readonly configService: ConfigService,
        private readonly bitcoinRpc: BitcoinRpcService,
    ) {
    }

    public createChallenge(address: string): { message: string; onchain: { address: string; amountSats: number } } {
        const challenge = this.challengeStore.issue(address);
        return {
            message: this.buildMessage(address, challenge.nonce),
            onchain: { address, amountSats: challenge.requiredAmountSats },
        };
    }

    // Verifies a signed challenge and, on success, issues a JWT scoped to
    // this one address (sub claim) -- the same signature scheme Bitcoin
    // Core's signmessage/verifymessage RPCs use, so any wallet that can sign
    // a message for its own address (Electrum, Sparrow, Bitcoin Core CLI,
    // most hardware wallets) can log in without the pool ever handling a
    // password or private key. Elektron Net's own wallet only supports this
    // for legacy P2PKH addresses (not SegWit/bech32) -- see loginOnChain for
    // the alternative that works for any address type.
    public async login(address: string, signature: string): Promise<{ accessToken: string }> {
        const challenge = this.challengeStore.peek(address);
        if (challenge == null) {
            throw new UnauthorizedException('No pending login challenge for this address (it may have expired) -- request a new one');
        }

        const message = this.buildMessage(address, challenge.nonce);
        let valid: boolean;
        try {
            valid = bitcoinMessage.verify(message, address, signature, undefined, true);
        } catch (e) {
            throw new UnauthorizedException(`Invalid signature: ${e?.message ?? e}`);
        }

        if (!valid) {
            throw new UnauthorizedException('Signature does not match address');
        }

        this.challengeStore.consume(address);
        return await this.issueToken(address);
    }

    // Alternative proof for wallets that can't sign a message for their
    // address (Elektron Net's own GUI/CLI wallet included -- signmessage
    // there is P2PKH-only). Instead, the miner sends themselves
    // (self-send, any wallet supports this regardless of address type) the
    // exact nonce-derived amount from createChallenge's `onchain` field,
    // and this checks whether a matching UTXO now exists via scantxoutset.
    // Requires at least one confirmation (scantxoutset scans the confirmed
    // UTXO set, not the mempool), so this is meant to be polled from the UI
    // rather than a one-shot call.
    public async loginOnChain(address: string): Promise<{ accessToken: string }> {
        const challenge = this.challengeStore.peek(address);
        if (challenge == null) {
            throw new UnauthorizedException('No pending login challenge for this address (it may have expired) -- request a new one');
        }

        const found = await this.bitcoinRpc.scanAddressForAmountSats(address, challenge.requiredAmountSats);
        if (!found) {
            throw new UnauthorizedException(
                `No matching on-chain payment seen yet. Send yourself (self-send) exactly `
                + `${challenge.requiredAmountSats} sats from ${address}, wait for it to confirm, then try again.`,
            );
        }

        this.challengeStore.consume(address);
        return await this.issueToken(address);
    }

    private async issueToken(address: string): Promise<{ accessToken: string }> {
        const payload: IJwtPayload = { sub: address };
        const accessToken = await this.jwtService.signAsync(payload, {
            secret: this.getJwtSecret(),
            expiresIn: JWT_EXPIRES_IN,
        });
        return { accessToken };
    }

    private buildMessage(address: string, nonce: string): string {
        return `Sign this message to log in to the Elektron Net PPLNS Pool.\n\nAddress: ${address}\nNonce: ${nonce}\n\nThis request will not move any funds.`;
    }

    private getJwtSecret(): string {
        const secret = this.configService.get<string>('JWT_SECRET');
        if (secret == null || secret.length < 16) {
            throw new Error('JWT_SECRET is not configured (or too short) -- set a random 32+ character value in .env');
        }
        return secret;
    }
}
