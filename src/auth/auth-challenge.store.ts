import { Injectable } from '@nestjs/common';
import * as crypto from 'node:crypto';

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

interface IChallenge {
    nonce: string;
    expiresAt: number;
}

// In-memory only, deliberately: challenges are single-use, short-lived
// (5 minutes) proof-of-address-ownership nonces, not data anyone needs to
// survive a restart. Keeping them out of the DB avoids a migration for
// something that's worthless a few minutes after issuance. Single-instance
// only, consistent with PayoutSchedulerService/PplnsShareLogService -- a
// clustered deployment would need a shared store (e.g. Redis) instead.
@Injectable()
export class AuthChallengeStore {

    private readonly challenges = new Map<string, IChallenge>();

    public issue(address: string): string {
        const nonce = crypto.randomBytes(16).toString('hex');
        this.challenges.set(address, { nonce, expiresAt: Date.now() + CHALLENGE_TTL_MS });
        return nonce;
    }

    // One-time use: consumed whether or not the caller goes on to verify the
    // signature, so a leaked/expired nonce can't be replayed.
    public consume(address: string): string | null {
        const challenge = this.challenges.get(address);
        this.challenges.delete(address);
        if (challenge == null || challenge.expiresAt < Date.now()) {
            return null;
        }
        return challenge.nonce;
    }
}
