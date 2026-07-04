import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { BitcoinRpcModule } from '../services/bitcoin-rpc.module';
import { AuthChallengeStore } from './auth-challenge.store';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';

@Module({
    imports: [JwtModule.register({}), BitcoinRpcModule],
    controllers: [AuthController],
    providers: [AuthService, AuthChallengeStore, JwtAuthGuard],
    // JwtModule itself must be re-exported, not just JwtAuthGuard -- Nest
    // resolves @UseGuards(JwtAuthGuard) in the *consuming* module's injector
    // context (AppModule, since that's where MinerAccountController lives),
    // so JwtService has to be reachable from there too.
    exports: [JwtAuthGuard, JwtModule],
})
export class AuthModule { }
