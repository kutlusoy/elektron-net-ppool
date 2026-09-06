import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { firstValueFrom } from 'rxjs';

// See doc-elektron/guideline-pool-registry-reporting.md. Replaces the
// reverted on-chain pool-identity outputs: this pool reports blocks it
// finds directly to every mempool explorer instance listed in the shared
// elektron-net-registry repo's mempools.txt, over plain HTTP, no wallet
// or on-chain data involved.

interface RegistryMempoolEntry {
    name: string;
    url: string;
}

const REGISTRY_POLL_INTERVAL_MS = 15 * 60 * 1000;
// Comfortably longer than any mempool instance should ever take to receive
// a report and call back to confirm it - this is not a cache of "how long
// ago was this block found", just a bound on memory growth.
const RECENT_BLOCK_TTL_MS = 30 * 60 * 1000;
const REPORT_TIMEOUT_MS = 5000;

@Injectable()
export class PoolRegistryService implements OnModuleInit {
    private readonly logger = new Logger(PoolRegistryService.name);
    private mempools: RegistryMempoolEntry[] = [];
    private readonly recentlyFoundBlocks = new Map<string, number>(); // lowercase block hash -> found-at (ms)

    constructor(
        private readonly httpService: HttpService,
        private readonly configService: ConfigService,
    ) { }

    async onModuleInit(): Promise<void> {
        await this.refreshRegistry();
    }

    @Interval(REGISTRY_POLL_INTERVAL_MS)
    public async refreshRegistry(): Promise<void> {
        const base = this.configService.get<string>('MEMPOOL_REGISTRY_URL')?.trim().replace(/\/$/, '');
        if (!base) {
            return;
        }
        try {
            const response = await firstValueFrom(this.httpService.get<string>(`${base}/mempools.txt`, {
                responseType: 'text',
                timeout: 10000,
            }));
            this.mempools = parseMempoolsRegistry(response.data);
        } catch (e) {
            this.logger.warn(`Failed to refresh mempool registry from ${base}/mempools.txt: ${(e as Error).message}`);
        }
    }

    public recordFoundBlock(blockHash: string): void {
        this.recentlyFoundBlocks.set(blockHash.toLowerCase(), Date.now());
        this.pruneOldEntries();
    }

    public wasRecentlyFound(blockHash: string): boolean {
        this.pruneOldEntries();
        return this.recentlyFoundBlocks.has(blockHash.toLowerCase());
    }

    private pruneOldEntries(): void {
        const cutoff = Date.now() - RECENT_BLOCK_TTL_MS;
        for (const [hash, foundAt] of this.recentlyFoundBlocks) {
            if (foundAt < cutoff) {
                this.recentlyFoundBlocks.delete(hash);
            }
        }
    }

    /**
     * Reports a found block to every mempool instance known from the
     * registry. Best-effort: a mempool that doesn't answer just never gets
     * this block attributed, nothing else in the pool depends on it.
     * @asyncSafe
     */
    public async reportBlockFound(blockHash: string): Promise<void> {
        this.recordFoundBlock(blockHash);

        const name = this.configService.get<string>('POOL_IDENTIFIER')?.trim();
        if (!name || this.mempools.length === 0) {
            return;
        }

        await Promise.all(this.mempools.map(async (mempool) => {
            try {
                await firstValueFrom(this.httpService.post(
                    `${mempool.url.replace(/\/$/, '')}/api/v1/pool-registry/report`,
                    { name, blockHash },
                    { timeout: REPORT_TIMEOUT_MS },
                ));
            } catch (e) {
                this.logger.debug(`Failed to report block ${blockHash} to ${mempool.name} (${mempool.url}): ${(e as Error).message}`);
            }
        }));
    }
}

function parseMempoolsRegistry(text: string): RegistryMempoolEntry[] {
    const entries: RegistryMempoolEntry[] = [];
    for (const rawLine of (text ?? '').split('\n')) {
        const line = rawLine.trim();
        if (line.length === 0) {
            continue;
        }
        const fields = [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => m[1]);
        if (fields.length !== 2) {
            continue; // malformed line, skip rather than fail the whole registry
        }
        const [name, url] = fields;
        if (name.trim().length === 0 || url.trim().length === 0) {
            continue;
        }
        entries.push({ name: name.trim(), url: url.trim() });
    }
    return entries;
}
