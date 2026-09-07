import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { firstValueFrom } from 'rxjs';
import * as fs from 'fs';
import * as path from 'path';

// See doc-elektron/guideline-pool-registry-reporting.md. Replaces the
// reverted on-chain pool-identity outputs: this pool reports blocks it
// finds directly to every mempool explorer instance listed in the shared
// elektron-net-registry repo's mempools.txt, over plain HTTP, no wallet
// or on-chain data involved.

interface RegistryMempoolEntry {
    name: string;
    url: string;
}

// Baked-in fallback so this works out of the box on any existing
// deployment's .env, with no MEMPOOL_REGISTRY_URL line at all -- only ever
// overridden if the operator actually sets that variable.
const DEFAULT_MEMPOOL_REGISTRY_URL = 'https://raw.githubusercontent.com/kutlusoy/elektron-net-registry/main';
// Local, on-disk copy of the last successfully fetched mempools.txt, in the
// same directory as the sqlite DB (already a persisted volume). Read first
// on startup so this pool has a usable list immediately even if the
// registry host is unreachable at boot, then kept in sync in the
// background -- see doc-elektron/guideline-pool-registry-reporting.md.
const LOCAL_REGISTRY_CACHE_PATH = './DB/mempools-registry.txt';

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
        this.loadLocalCache();
        await this.refreshRegistry();
    }

    private loadLocalCache(): void {
        try {
            const text = fs.readFileSync(LOCAL_REGISTRY_CACHE_PATH, 'utf8');
            this.mempools = parseMempoolsRegistry(text);
        } catch {
            // No local cache yet (first run) -- fine, refreshRegistry() below
            // will populate it as soon as the registry is reachable.
        }
    }

    private saveLocalCache(text: string): void {
        try {
            fs.mkdirSync(path.dirname(LOCAL_REGISTRY_CACHE_PATH), { recursive: true });
            fs.writeFileSync(LOCAL_REGISTRY_CACHE_PATH, text);
        } catch (e) {
            this.logger.warn(`Failed to save local mempool registry cache: ${(e as Error).message}`);
        }
    }

    @Interval(REGISTRY_POLL_INTERVAL_MS)
    public async refreshRegistry(): Promise<void> {
        const base = (this.configService.get<string>('MEMPOOL_REGISTRY_URL')?.trim() || DEFAULT_MEMPOOL_REGISTRY_URL).replace(/\/$/, '');
        try {
            const response = await firstValueFrom(this.httpService.get<string>(`${base}/mempools.txt`, {
                responseType: 'text',
                timeout: 10000,
            }));
            // Never let a fetch that returns garbage (a GitHub outage page,
            // a redirect to an HTML error, etc.) wipe out an already-known
            // good list -- only replace it once the response actually
            // parses into at least one entry.
            const entries = parseMempoolsRegistry(response.data);
            if (entries.length > 0) {
                this.mempools = entries;
                this.saveLocalCache(response.data);
            }
        } catch (e) {
            // Registry unreachable (e.g. GitHub is down) -- keep whatever is
            // already loaded (local cache or a previous successful fetch)
            // rather than going empty.
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

// Only ever extracts quoted substrings, so it is agnostic to whatever
// separator sits between them (comma, semicolon, or nothing) -- only the
// quoted content is read.
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
