import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { PoolAccountingEntity } from './pool-accounting.entity';

const SINGLETON_ID = 1;

@Injectable()
export class PoolAccountingService {

    constructor(
        @InjectRepository(PoolAccountingEntity)
        private readonly poolAccountingRepository: Repository<PoolAccountingEntity>,
    ) {
    }

    public async addFeeAndDust(feeSats: number, dustSats: number): Promise<void> {
        await this.poolAccountingRepository
            .createQueryBuilder()
            .insert()
            .into(PoolAccountingEntity)
            .values({ id: SINGLETON_ID, totalFeeSats: 0, totalDustSats: 0 })
            .orIgnore()
            .execute();

        await this.poolAccountingRepository
            .createQueryBuilder()
            .update(PoolAccountingEntity)
            .set({
                totalFeeSats: () => `"totalFeeSats" + ${feeSats}`,
                totalDustSats: () => `"totalDustSats" + ${dustSats}`,
            })
            .where('id = :id', { id: SINGLETON_ID })
            .execute();
    }

    public async get(): Promise<{ totalFeeSats: number; totalDustSats: number }> {
        const row = await this.poolAccountingRepository.findOne({ where: { id: SINGLETON_ID } });
        return {
            totalFeeSats: row?.totalFeeSats ?? 0,
            totalDustSats: row?.totalDustSats ?? 0,
        };
    }
}
