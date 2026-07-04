import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { MinerAccountSettingsService } from '../../ORM/miner-account-settings/miner-account-settings.service';
import { UpdateMinerAccountSettingsDto } from './miner-account-settings.dto';

const DEFAULT_MIN_PAYOUT_THRESHOLD_SATS = 100000;

// Phase 2 (concept doc §11): account settings, gated behind the
// signature-based login from AuthController -- the JwtAuthGuard rejects any
// token whose `sub` doesn't match the :address in the URL, so a miner can
// only ever read/write their own settings.
@Controller('miner')
@UseGuards(JwtAuthGuard)
export class MinerAccountController {

    constructor(
        private readonly minerAccountSettingsService: MinerAccountSettingsService,
        private readonly configService: ConfigService,
    ) {
    }

    @Get(':address/account-settings')
    async getSettings(@Param('address') address: string) {
        const settings = await this.minerAccountSettingsService.getSettings(address);
        return {
            payoutThresholdSatsOverride: settings?.payoutThresholdSatsOverride ?? null,
            notifyOnPayout: settings?.notifyOnPayout ?? false,
            poolDefaultPayoutThresholdSats: this.getPoolDefaultThresholdSats(),
        };
    }

    @Patch(':address/account-settings')
    async updateSettings(@Param('address') address: string, @Body() body: UpdateMinerAccountSettingsDto) {
        const changes: { payoutThresholdSatsOverride?: number | null; notifyOnPayout?: boolean } = {};
        if ('payoutThresholdSatsOverride' in body) {
            changes.payoutThresholdSatsOverride = body.payoutThresholdSatsOverride ?? null;
        }
        if ('notifyOnPayout' in body) {
            changes.notifyOnPayout = body.notifyOnPayout;
        }

        const settings = await this.minerAccountSettingsService.upsertSettings(address, changes);
        return {
            payoutThresholdSatsOverride: settings.payoutThresholdSatsOverride ?? null,
            notifyOnPayout: settings.notifyOnPayout,
            poolDefaultPayoutThresholdSats: this.getPoolDefaultThresholdSats(),
        };
    }

    private getPoolDefaultThresholdSats(): number {
        const configured = parseInt(this.configService.get<string>('MIN_PAYOUT_THRESHOLD_SATS'), 10);
        return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MIN_PAYOUT_THRESHOLD_SATS;
    }
}
