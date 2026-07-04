import { Injectable } from '@nestjs/common';
import * as crypto from 'node:crypto';

// 30 minutes: long enough to cover the on-chain proof path (concept doc
// §11 alternative login) -- Elektron Net blocks are ~60s, and the miner
// needs to broadcast a self-send *and* wait for it to confirm before
// scantxoutset will see it, which the message-signing path doesn't need
// but shares the same challenge/TTL machinery.
const CHALLENGE_TTL_MS = 30 * 60 * 1000;

// Sats range for the on-chain proof amount -- arbitrary but wide enough
// (~99000 possible values) that a fresh random pick landing on an amount
// the address already happens to hold as a pre-existing UTXO is
// vanishingly unlikely. Not a high-security bound (this gates account
// *settings*, not fund custody), just enough to make the amount a
// meaningful, unpredictable-in-advance marker for this one login attempt.
const ONCHAIN_AMOUNT_MIN_SATS = 1000;
const ONCHAIN_AMOUNT_RANGE_SATS = 99000;

export interface IChallenge {
    nonce: string;
    requiredAmountSats: number;
    expiresAt: number;
}

// In-memory only, deliberately: challenges are single-use, time-boxed
// proof-of-address-ownership records, not data anyone needs to survive a
// restart. Keeping them out of the DB avoids a migration for something
// that's worthless once it expires. Single-instance only, consistent with
// PayoutSchedulerService/PplnsShareLogService -- a clustered deployment
// would need a shared store (e.g. Redis) instead.
@Injectable()
export class AuthChallengeStore {

    private readonly challenges = new Map<string, IChallenge>();

    public issue(address: string): IChallenge {
        const challenge: IChallenge = {
            nonce: crypto.randomBytes(16).toString('hex'),
            requiredAmountSats: ONCHAIN_AMOUNT_MIN_SATS + crypto.randomInt(ONCHAIN_AMOUNT_RANGE_SATS),
            expiresAt: Date.now() + CHALLENGE_TTL_MS,
        };
        this.challenges.set(address, challenge);
        return challenge;
    }

    // Non-destructive: both login paths may need to check the same
    // still-pending challenge more than once (a wrong/rejected signature
    // attempt, or polling while an on-chain self-send is still
    // unconfirmed) without being forced to restart the whole flow.
    public peek(address: string): IChallenge | null {
        const challenge = this.challenges.get(address);
        if (challenge == null) {
            return null;
        }
        if (challenge.expiresAt < Date.now()) {
            this.challenges.delete(address);
            return null;
        }
        return challenge;
    }

    // Call only once a login attempt actually succeeds, so the same
    // challenge (signature or on-chain amount) can't be reused afterwards.
    public consume(address: string): void {
        this.challenges.delete(address);
    }
}
