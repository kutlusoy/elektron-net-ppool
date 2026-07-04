import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bitcoinMessage from 'bitcoinjs-message';

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
    ) {
    }

    public createChallenge(address: string): { message: string } {
        const nonce = this.challengeStore.issue(address);
        return { message: this.buildMessage(address, nonce) };
    }

    // Verifies a signed challenge and, on success, issues a JWT scoped to
    // this one address (sub claim) -- the same signature scheme Bitcoin
    // Core's signmessage/verifymessage RPCs use, so any wallet that can sign
    // a message for its own address (Electrum, Sparrow, Bitcoin Core CLI,
    // most hardware wallets) can log in without the pool ever handling a
    // password or private key.
    public async login(address: string, signature: string): Promise<{ accessToken: string }> {
        const nonce = this.challengeStore.consume(address);
        if (nonce == null) {
            throw new UnauthorizedException('No pending login challenge for this address (it may have expired) -- request a new one');
        }

        const message = this.buildMessage(address, nonce);
        let valid: boolean;
        try {
            valid = bitcoinMessage.verify(message, address, signature, undefined, true);
        } catch (e) {
            throw new UnauthorizedException(`Invalid signature: ${e?.message ?? e}`);
        }

        if (!valid) {
            throw new UnauthorizedException('Signature does not match address');
        }

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
