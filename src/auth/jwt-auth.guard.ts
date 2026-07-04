import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

import { IJwtPayload } from './auth.service';

// Verifies the Bearer JWT and enforces that its `sub` (the address that
// signed the login challenge) matches the :address route param being
// accessed -- a valid token for address A must never grant access to
// address B's settings.
@Injectable()
export class JwtAuthGuard implements CanActivate {

    constructor(
        private readonly jwtService: JwtService,
        private readonly configService: ConfigService,
    ) {
    }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest();
        const authHeader: string | undefined = request.headers?.authorization;
        if (authHeader == null || !authHeader.startsWith('Bearer ')) {
            throw new UnauthorizedException('Missing Bearer token');
        }

        const token = authHeader.slice('Bearer '.length);
        let payload: IJwtPayload;
        try {
            payload = await this.jwtService.verifyAsync<IJwtPayload>(token, { secret: this.getJwtSecret() });
        } catch (e) {
            throw new UnauthorizedException(`Invalid or expired token: ${e?.message ?? e}`);
        }

        const routeAddress = request.params?.address;
        if (routeAddress != null && routeAddress !== payload.sub) {
            throw new UnauthorizedException('Token does not grant access to this address');
        }

        request.minerAddress = payload.sub;
        return true;
    }

    private getJwtSecret(): string {
        const secret = this.configService.get<string>('JWT_SECRET');
        if (secret == null || secret.length < 16) {
            throw new Error('JWT_SECRET is not configured (or too short) -- set a random 32+ character value in .env');
        }
        return secret;
    }
}
