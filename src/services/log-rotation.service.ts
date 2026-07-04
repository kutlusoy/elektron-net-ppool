import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as fs from 'fs';
import * as path from 'path';

// File-backed daily-rotating logger. Mirrors anything written through the
// usual console.* sinks (the entire codebase logs via console.log) into a
// dated file inside LOG_DIR so operators can inspect history after the
// process restarts, without letting the file grow unbounded.
//
// Rotation: a fresh file is created on the date roll-over (midnight UTC)
// and on every daily cron tick we sweep files older than
// LOG_RETENTION_DAYS so disk usage stays bounded.
@Injectable()
export class LogRotationService implements OnModuleInit {

    private readonly logger = new Logger(LogRotationService.name);
    private readonly logDir: string;
    private readonly retentionDays: number;
    private currentDate: string | null = null;
    private currentStream: fs.WriteStream | null = null;

    constructor() {
        this.logDir = process.env.LOG_DIR || './DB/logs';
        const parsed = parseInt(process.env.LOG_RETENTION_DAYS || '7', 10);
        this.retentionDays = Number.isFinite(parsed) && parsed > 0 ? parsed : 7;
    }

    onModuleInit() {
        if (process.env.NODE_APP_INSTANCE != null && process.env.NODE_APP_INSTANCE != '0') {
            return;
        }

        try {
            fs.mkdirSync(this.logDir, { recursive: true });
        } catch (e) {
            this.logger.warn(`Unable to create log directory ${this.logDir}: ${(e as Error).message}`);
            return;
        }

        this.installConsoleHook();
        this.cleanupOldLogs();
    }

    @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
    public dailyRotate() {
        try {
            this.rollStream();
            this.cleanupOldLogs();
        } catch (e) {
            // Log via the original logger; we don't want the cron to throw.
            this.logger.error(`Daily log rotation failed: ${(e as Error).message}`);
        }
    }

    private installConsoleHook() {
        const originalLog = console.log.bind(console);
        const originalInfo = console.info.bind(console);
        const originalWarn = console.warn.bind(console);
        const originalError = console.error.bind(console);

        const write = (level: string, args: any[]) => {
            try {
                const line = `${new Date().toISOString()} [${level}] ${args.map(formatArg).join(' ')}\n`;
                this.ensureStream().write(line);
            } catch {
                // never let logging crash the process
            }
        };

        console.log = (...args: any[]) => { write('LOG', args); originalLog(...args); };
        console.info = (...args: any[]) => { write('INFO', args); originalInfo(...args); };
        console.warn = (...args: any[]) => { write('WARN', args); originalWarn(...args); };
        console.error = (...args: any[]) => { write('ERROR', args); originalError(...args); };
    }

    private ensureStream(): fs.WriteStream {
        const today = this.todayStamp();
        if (this.currentStream != null && this.currentDate === today) {
            return this.currentStream;
        }
        this.rollStream(today);
        return this.currentStream!;
    }

    private rollStream(date?: string) {
        const target = date ?? this.todayStamp();
        if (this.currentStream != null) {
            try { this.currentStream.end(); } catch { /* ignore */ }
            this.currentStream = null;
        }
        const filePath = path.join(this.logDir, `pool-${target}.log`);
        this.currentStream = fs.createWriteStream(filePath, { flags: 'a' });
        this.currentDate = target;
    }

    private cleanupOldLogs() {
        let files: string[];
        try {
            files = fs.readdirSync(this.logDir);
        } catch {
            return;
        }

        const cutoff = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
        for (const name of files) {
            if (!/^pool-\d{4}-\d{2}-\d{2}\.log$/.test(name)) {
                continue;
            }
            const full = path.join(this.logDir, name);
            try {
                const stat = fs.statSync(full);
                if (stat.mtimeMs < cutoff) {
                    fs.unlinkSync(full);
                }
            } catch {
                // ignore individual file failures
            }
        }
    }

    private todayStamp(): string {
        const now = new Date();
        const year = now.getUTCFullYear();
        const month = String(now.getUTCMonth() + 1).padStart(2, '0');
        const day = String(now.getUTCDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }
}

function formatArg(arg: any): string {
    if (arg instanceof Error) {
        return arg.stack ?? `${arg.name}: ${arg.message}`;
    }
    if (typeof arg === 'string') {
        return arg;
    }
    try {
        return JSON.stringify(arg);
    } catch {
        return String(arg);
    }
}
