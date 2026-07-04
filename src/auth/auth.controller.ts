import { Body, Controller, Post } from '@nestjs/common';
import { IsNotEmpty, IsString } from 'class-validator';

import { AuthService } from './auth.service';

class ChallengeRequestDto {
    @IsString()
    @IsNotEmpty()
    address: string;
}

class LoginRequestDto {
    @IsString()
    @IsNotEmpty()
    address: string;

    @IsString()
    @IsNotEmpty()
    signature: string;
}

class OnChainLoginRequestDto {
    @IsString()
    @IsNotEmpty()
    address: string;
}

// Phase 2 (concept doc §11): two alternative ways to log in, both
// starting from the same challenge:
//   1. POST /auth/challenge { address } -> { message, onchain: { address, amountSats } }
//   2a. Signature path: sign `message` with the wallet that controls
//       `address` (e.g. Bitcoin Core `signmessage`, Electrum, Sparrow --
//       NOT Elektron Net's own wallet for SegWit/bech32 addresses, see
//       AuthService.login), then POST /auth/login { address, signature }
//   2b. On-chain path (works for any address type): send yourself
//       (self-send) exactly `onchain.amountSats` sats from `address`, wait
//       for a confirmation, then poll POST /auth/onchain-login { address }
//       until it succeeds.
//   3. Either path returns -> { accessToken }
//   4. Use `Authorization: Bearer <accessToken>` on the /miner/:address/
//      account-settings endpoints (see MinerAccountController).
@Controller('auth')
export class AuthController {

    constructor(private readonly authService: AuthService) {
    }

    @Post('challenge')
    async challenge(@Body() body: ChallengeRequestDto) {
        return this.authService.createChallenge(body.address);
    }

    @Post('login')
    async login(@Body() body: LoginRequestDto) {
        return await this.authService.login(body.address, body.signature);
    }

    @Post('onchain-login')
    async onchainLogin(@Body() body: OnChainLoginRequestDto) {
        return await this.authService.loginOnChain(body.address);
    }
}
