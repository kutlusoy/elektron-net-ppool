import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { MinerAccountSettingsEntity } from './miner-account-settings.entity';

@Injectable()
export class MinerAccountSettingsService {

    constructor(
        @InjectRepository(MinerAccountSettingsEntity)
        private readonly repository: Repository<MinerAccountSettingsEntity>,
    ) {
    }

    public async getSettings(address: string): Promise<MinerAccountSettingsEntity | null> {
        return await this.repository.findOne({ where: { address } });
    }

    public async upsertSettings(
        address: string,
        changes: { payoutThresholdSatsOverride?: number | null; notifyOnPayout?: boolean },
    ): Promise<MinerAccountSettingsEntity> {
        await this.repository
            .createQueryBuilder()
            .insert()
            .into(MinerAccountSettingsEntity)
            .values({ address })
            .orIgnore()
            .execute();

        if (Object.keys(changes).length > 0) {
            await this.repository.update({ address }, changes);
        }

        return await this.repository.findOne({ where: { address } });
    }

    // Used by PayoutLedgerService when computing per-miner effective
    // thresholds -- returns a map so callers don't do one query per miner.
    public async getOverridesByAddress(addresses: string[]): Promise<Map<string, number>> {
        if (addresses.length === 0) {
            return new Map();
        }

        const rows = await this.repository
            .createQueryBuilder('settings')
            .select('settings.address', 'address')
            .addSelect('settings.payoutThresholdSatsOverride', 'payoutThresholdSatsOverride')
            .where('settings.address IN (:...addresses)', { addresses })
            .andWhere('settings.payoutThresholdSatsOverride IS NOT NULL')
            .getRawMany();

        return new Map(rows.map(row => [row.address, Number(row.payoutThresholdSatsOverride)]));
    }

    public async getNotifyOnPayoutAddresses(addresses: string[]): Promise<Set<string>> {
        if (addresses.length === 0) {
            return new Set();
        }

        const rows = await this.repository
            .createQueryBuilder('settings')
            .select('settings.address', 'address')
            .where('settings.address IN (:...addresses)', { addresses })
            .andWhere('settings.notifyOnPayout = :notify', { notify: true })
            .getRawMany();

        return new Set(rows.map(row => row.address));
    }
}
