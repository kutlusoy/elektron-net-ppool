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

// Phase 2 (concept doc §11): signature-based login. Flow:
//   1. POST /auth/challenge { address } -> { message }
//   2. Miner signs `message` with the wallet that controls `address`
//      (e.g. Bitcoin Core `signmessage`, Electrum, Sparrow)
//   3. POST /auth/login { address, signature } -> { accessToken }
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
}
