import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { PplnsShareEntity } from './pplns-share.entity';

const DEFAULT_WINDOW_MINUTES = 90;
const DEFAULT_PRUNE_INTERVAL_MS = 60 * 60 * 1000; // hourly, per concept doc §5.1
const PRUNE_SAFETY_MARGIN_MS = 60 * 60 * 1000; // keep 1h beyond the window in case it's widened live

@Injectable()
export class PplnsShareLogService implements OnModuleInit {

    constructor(
        @InjectRepository(PplnsShareEntity)
        private readonly pplnsShareRepository: Repository<PplnsShareEntity>,
        private readonly configService: ConfigService,
    ) {
    }

    onModuleInit() {
        // Only one process needs to run the cleanup sweep; mirrors the
        // NODE_APP_INSTANCE guard used by LogRotationService for PM2 cluster mode.
        if (process.env.NODE_APP_INSTANCE != null && process.env.NODE_APP_INSTANCE !== '0') {
            return;
        }

        setInterval(() => {
            const cutoffMs = Date.now() - this.getWindowMinutes() * 60 * 1000 - PRUNE_SAFETY_MARGIN_MS;
            this.pruneOlderThan(cutoffMs).catch(e => {
                console.error(`PPLNS share log pruning failed: ${e?.message ?? e}`);
            });
        }, DEFAULT_PRUNE_INTERVAL_MS);
    }

    public getWindowMinutes(): number {
        const configured = parseInt(this.configService.get<string>('PPLNS_WINDOW_MINUTES'), 10);
        return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_WINDOW_MINUTES;
    }

    public async record(minerAddress: string, difficulty: number, blockHeight: number): Promise<void> {
        await this.pplnsShareRepository.insert({
            minerAddress,
            difficulty,
            timestamp: Date.now(),
            blockHeightAtSubmission: blockHeight,
        });
    }

    public async getSharesInWindow(windowStartMs: number): Promise<PplnsShareEntity[]> {
        return await this.pplnsShareRepository
            .createQueryBuilder('share')
            .where('share.timestamp >= :windowStartMs', { windowStartMs })
            .getMany();
    }

    public async getWindowStats(windowStartMs: number): Promise<{ totalDifficultyInWindow: number; activeMinerCount: number }> {
        const result = await this.pplnsShareRepository
            .createQueryBuilder('share')
            .select('COALESCE(SUM(share.difficulty), 0)', 'totalDifficulty')
            .addSelect('COUNT(DISTINCT share.minerAddress)', 'activeMinerCount')
            .where('share.timestamp >= :windowStartMs', { windowStartMs })
            .getRawOne();

        return {
            totalDifficultyInWindow: Number(result?.totalDifficulty ?? 0),
            activeMinerCount: Number(result?.activeMinerCount ?? 0),
        };
    }

    public async pruneOlderThan(cutoffMs: number): Promise<void> {
        await this.pplnsShareRepository
            .createQueryBuilder()
            .delete()
            .where('timestamp < :cutoffMs', { cutoffMs })
            .execute();
    }
}
