import { ConfigService } from '@nestjs/config';
import * as bitcoinjs from 'bitcoinjs-lib';
import { plainToInstance } from 'class-transformer';
import { validate, ValidationError, ValidatorOptions } from 'class-validator';
import * as crypto from 'crypto';
import { Socket } from 'net';
import { Subscription } from 'rxjs';
import { clearInterval } from 'timers';

import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { BlocksService } from '../ORM/blocks/blocks.service';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientEntity } from '../ORM/client/client.entity';
import { ClientService } from '../ORM/client/client.service';
import { BitcoinRpcService } from '../services/bitcoin-rpc.service';
import { NotificationService } from '../services/notification.service';
import { IJobTemplate, StratumV1JobsService } from '../services/stratum-v1-jobs.service';
import { eRequestMethod } from './enums/eRequestMethod';
import { eResponseMethod } from './enums/eResponseMethod';
import { eStratumErrorCode } from './enums/eStratumErrorCode';
import { MiningJob } from './MiningJob';
import { AuthorizationMessage } from './stratum-messages/AuthorizationMessage';
import { ConfigurationMessage } from './stratum-messages/ConfigurationMessage';
import { MiningSubmitMessage } from './stratum-messages/MiningSubmitMessage';
import { StratumErrorMessage } from './stratum-messages/StratumErrorMessage';
import { SubscriptionMessage } from './stratum-messages/SubscriptionMessage';
import { SUBSCRIBE_SESSION_ID_BYTES } from './stratum.constants';
import { SuggestDifficulty } from './stratum-messages/SuggestDifficultyMessage';
import { StratumV1ClientStatistics } from './StratumV1ClientStatistics';
import { ExternalSharesService } from '../services/external-shares.service';
import { elektronMainnet, elektronRegtest } from '../utils/elektron-network';
import { PplnsShareLogService } from '../ORM/pplns-shares/pplns-shares.service';
import { RewardCalculatorService } from '../pplns/reward-calculator.service';

const TRUE_DIFF_ONE = 2.695953529101131e67;
const BLOCKED_USER_AGENT_LOG_INTERVAL_MS = 60 * 1000;
const VALIDATION_ERROR_LOG_INTERVAL_MS = 60 * 1000;

export class StratumV1Client {
    private static blockedUserAgentLogState = new Map<string, { nextLogAt: number, suppressed: number }>();
    private static validationErrorLogState = new Map<string, { nextLogAt: number, suppressed: number, sample: string }>();

    private clientSubscription: SubscriptionMessage;
    private clientConfiguration: ConfigurationMessage;
    private clientAuthorization: AuthorizationMessage;
    private clientSuggestedDifficulty: SuggestDifficulty;
    private stratumSubscription: Subscription;
    private backgroundWork: NodeJS.Timeout[] = [];

    private statistics: StratumV1ClientStatistics;
    private stratumInitialized = false;
    private usedSuggestedDifficulty = false;
    private sessionDifficulty: number = 100000;
    private isHobbyMinerSession = false;

    private entity: ClientEntity;
    private creatingEntity: Promise<void>;

    public extraNonceAndSessionId: string;
    public sessionStart: Date;
    public noFee: boolean;
    public hashRate: number = 0;

    private buffer: string = '';
    private connectionClosed = false;
    private lastSentMiningJobTimestamp: number = null;

    private miningSubmissionHashes = new Set<string>()

    constructor(
        public readonly socket: Socket,
        private readonly stratumV1JobsService: StratumV1JobsService,
        private readonly bitcoinRpcService: BitcoinRpcService,
        private readonly clientService: ClientService,
        private readonly clientStatisticsService: ClientStatisticsService,
        private readonly notificationService: NotificationService,
        private readonly blocksService: BlocksService,
        private readonly configService: ConfigService,
        private readonly addressSettingsService: AddressSettingsService,
        private readonly externalSharesService: ExternalSharesService,
        private readonly pplnsShareLogService: PplnsShareLogService,
        private readonly rewardCalculatorService: RewardCalculatorService
    ) {

        this.socket.on('data', (data: Buffer) => {
            this.buffer += data.toString();
            let lines = this.buffer.split('\n');
            this.buffer = lines.pop() || ''; // Save the last part of the data (incomplete line) to the buffer

            (async () => {
                for (const m of lines.filter(l => l.length > 0)) {
                    if (this.connectionClosed || this.socket.destroyed || this.socket.writableEnded) {
                        break;
                    }
                    try {
                        await this.handleMessage(m);
                    } catch (e) {
                        await this.socket.end();
                        console.error(e);
                    }
                }
            })();
        });


    }

    public async destroy() {

        if (this.extraNonceAndSessionId) {
            await this.clientService.delete(this.extraNonceAndSessionId);
        }

        if (this.stratumSubscription != null) {
            this.stratumSubscription.unsubscribe();
        }

        this.backgroundWork.forEach(work => {
            clearInterval(work);
        });
    }

    private getRandomHexString() {
        // Per-connection session id, emitted as extranonce1 / notify channel
        // tag in the subscribe response so the ASIC firmware accepts the
        // connection. See stratum.constants.ts for why this has to be
        // non-empty even though we run header-only mining.
        const randomBytes = crypto.randomBytes(SUBSCRIBE_SESSION_ID_BYTES);
        return randomBytes.toString('hex');
    }


    private async handleMessage(message: string) {
        //console.log(`Received from ${this.extraNonceAndSessionId}`, message);

        // Parse the message and check if it's the initial subscription message
        let parsedMessage = null;
        try {
            parsedMessage = JSON.parse(message);
        } catch (e) {
            //console.log("Invalid JSON");
            await this.socket.end();
            return;
        }



        switch (parsedMessage.method) {
            case eRequestMethod.SUBSCRIBE: {
                const subscriptionMessage = plainToInstance(
                    SubscriptionMessage,
                    parsedMessage,
                );

                const validatorOptions: ValidatorOptions = {
                    whitelist: true,
                    //forbidNonWhitelisted: true,
                };

                const errors = await validate(subscriptionMessage, validatorOptions);

                if (errors.length === 0) {
                    if (this.isBlockedUserAgent(subscriptionMessage.userAgent)) {
                        this.logBlockedUserAgent(subscriptionMessage.userAgent);
                        this.closeSocket();
                        return;
                    }

                    if (this.sessionStart == null) {
                        this.sessionStart = new Date();
                        this.statistics = new StratumV1ClientStatistics(this.clientStatisticsService);
                        this.extraNonceAndSessionId = this.getRandomHexString();
                        this.isHobbyMinerSession = this.isHobbyMiner(subscriptionMessage.userAgent);
                        const mode = this.isHobbyMinerSession ? 'HOBBY' : 'NORMAL';
                        console.log(`New client ID: ${this.extraNonceAndSessionId}, userAgent=${subscriptionMessage.userAgent}, mode=${mode}, ${this.socket.remoteAddress}:${this.socket.remotePort}`);
                    }

                    this.clientSubscription = subscriptionMessage;
                    // Per-session subscribe response:
                    //   HOBBY  (NerdMiner family): non-empty extranonce1 to keep
                    //                              the firmware from aborting.
                    //   NORMAL (Bitaxe ESP-Miner, modern ASICs): empty extranonce1
                    //                              for byte-exact miner.py parity
                    //                              and clean share validation.
                    const success = await this.write(JSON.stringify(this.clientSubscription.response(this.extraNonceAndSessionId, this.isHobbyMinerSession)) + '\n');
                    if (!success) {
                        return;
                    }
                } else {
                    console.error('Subscription validation error');
                    const err = new StratumErrorMessage(
                        subscriptionMessage.id,
                        eStratumErrorCode.OtherUnknown,
                        'Subscription validation error',
                        errors).response();
                    console.error(err);
                    const success = await this.write(err);
                    if (!success) {
                        return;
                    }
                }

                break;
            }
            case eRequestMethod.CONFIGURE: {

                const configurationMessage = plainToInstance(
                    ConfigurationMessage,
                    parsedMessage,
                );

                const validatorOptions: ValidatorOptions = {
                    whitelist: true,
                    //forbidNonWhitelisted: true,
                };

                const errors = await validate(configurationMessage, validatorOptions);

                if (errors.length === 0) {
                    this.clientConfiguration = configurationMessage;
                    //const response = this.buildSubscriptionResponse(configurationMessage.id);
                    const success = await this.write(JSON.stringify(this.clientConfiguration.response()) + '\n');
                    if (!success) {
                        return;
                    }

                } else {
                    console.error('Configuration validation error');
                    const err = new StratumErrorMessage(
                        configurationMessage.id,
                        eStratumErrorCode.OtherUnknown,
                        'Configuration validation error',
                        errors).response();
                    console.error(err);
                    const success = await this.write(err);
                    if (!success) {
                        return;
                    }
                }

                break;
            }
            case eRequestMethod.AUTHORIZE: {

                const authorizationMessage = plainToInstance(
                    AuthorizationMessage,
                    parsedMessage,
                );

                const validatorOptions: ValidatorOptions = {
                    whitelist: true,
                    //forbidNonWhitelisted: true,
                };

                const errors = await validate(authorizationMessage, validatorOptions);

                if (errors.length === 0) {
                    this.clientAuthorization = authorizationMessage;
                    if (this.clientSuggestedDifficulty == null && this.clientAuthorization.startingDiff != null && this.clientAuthorization.startingDiff > this.sessionDifficulty) {
                        this.sessionDifficulty = this.clientAuthorization.startingDiff;
                    }
                    const success = await this.write(JSON.stringify(this.clientAuthorization.response()) + '\n');
                    if (!success) {
                        return;
                    }
                } else {
                    console.error('Authorization validation error');
                    const err = new StratumErrorMessage(
                        authorizationMessage.id,
                        eStratumErrorCode.OtherUnknown,
                        'Authorization validation error',
                        errors).response();
                    console.error(err);
                    const success = await this.write(err);
                    if (!success) {
                        return;
                    }
                }

                break;
            }
            case eRequestMethod.SUGGEST_DIFFICULTY: {
                if (this.usedSuggestedDifficulty == true) {
                    return;
                }

                const suggestDifficultyMessage = plainToInstance(
                    SuggestDifficulty,
                    parsedMessage
                );

                const validatorOptions: ValidatorOptions = {
                    whitelist: true,
                    //forbidNonWhitelisted: true,
                };

                const errors = await validate(suggestDifficultyMessage, validatorOptions);

                if (errors.length === 0) {

                    this.clientSuggestedDifficulty = suggestDifficultyMessage;
                    this.sessionDifficulty = suggestDifficultyMessage.suggestedDifficulty;
                    const success = await this.write(JSON.stringify(this.clientSuggestedDifficulty.response(this.sessionDifficulty)) + '\n');
                    if (!success) {
                        return;
                    }
                    this.usedSuggestedDifficulty = true;
                } else {
                    console.error('Suggest difficulty validation error');
                    const err = new StratumErrorMessage(
                        suggestDifficultyMessage.id,
                        eStratumErrorCode.OtherUnknown,
                        'Suggest difficulty validation error',
                        errors).response();
                    console.error(err);
                    const success = await this.write(err);
                    if (!success) {
                        return;
                    }
                }
                break;
            }
            case eRequestMethod.SUBMIT: {

                if (this.stratumInitialized == false) {
                    console.log('Submit before initalized');
                    await this.socket.end();
                    return;
                }


                const miningSubmitMessage = plainToInstance(
                    MiningSubmitMessage,
                    parsedMessage,
                );

                const validatorOptions: ValidatorOptions = {
                    whitelist: true,
                    //forbidNonWhitelisted: true,
                };

                const errors = await validate(miningSubmitMessage, validatorOptions);

                if (errors.length === 0 && this.stratumInitialized == true) {
                    // DIAGNOSTIC: dump raw mining.submit params so we can see
                    // exactly what the firmware sent in each position. Gated
                    // on any DIAGNOSTIC_SHARE_LOGGING_MODES being set, so it
                    // stays silent in production. NerdMiner v1.8.3 is
                    // suspected to send a hardcoded "00000001" as extranonce2
                    // even when the pool advertises extranonce2_size = 0; this
                    // log lets us confirm what arrives on the wire vs. what
                    // the validator parses into miningSubmitMessage.
                    const diagModesRaw = this.configService.get<string>('DIAGNOSTIC_SHARE_LOGGING_MODES');
                    if (diagModesRaw && diagModesRaw.trim().length > 0) {
                        try {
                            const rawParams = (parsedMessage as { params?: unknown })?.params;
                            console.log(`  [diag] raw mining.submit params: ${JSON.stringify(rawParams)}`);
                        } catch {
                            // ignore — diagnostic only
                        }
                    }
                    const result = await this.handleMiningSubmission(miningSubmitMessage);
                    if (result == true) {
                        const success = await this.write(JSON.stringify(miningSubmitMessage.response()) + '\n');
                        if (!success) {
                            return;
                        }
                    }


                } else {
                    this.logValidationError('Mining Submit validation error', errors);
                    const err = new StratumErrorMessage(
                        miningSubmitMessage.id,
                        eStratumErrorCode.OtherUnknown,
                        'Mining Submit validation error',
                        errors).response();
                    const success = await this.write(err);
                    if (!success) {
                        return;
                    }
                    this.closeSocket();
                    return;
                }
                break;
            }
            // default: {
            //     console.log("Invalid message");
            //     console.log(parsedMessage);
            //     await this.socket.end();
            //     return;
            // }
        }


        if (this.clientSubscription != null
            && this.clientAuthorization != null
            && this.stratumInitialized == false) {

            await this.initStratum();

        }
    }

    private async initStratum() {
        this.stratumInitialized = true;

        if (this.isBlockedUserAgent(this.clientSubscription.userAgent)) {
            this.logBlockedUserAgent(this.clientSubscription.userAgent);
            this.closeSocket();
            return;
        }

        if (this.isHobbyMinerSession) {
            // ESP32-class hobby miners running NerdMiner_v2-style firmware are
            // on the order of tens of kH/s. A single share at diff=1 would
            // take hours; drop the starting difficulty so shares actually
            // arrive within the pool's dead-client timeout window. Configurable
            // via HOBBY_MINER_DIFFICULTY env var. The HOBBY flag itself was
            // assigned at subscribe time from isHobbyMiner(userAgent).
            const configured = Number(this.configService.get<string>('HOBBY_MINER_DIFFICULTY'));
            this.sessionDifficulty = Number.isFinite(configured) && configured > 0 ? configured : 0.001;
        } else if (this.clientSubscription.userAgent === 'cpuminer') {
            this.sessionDifficulty = 0.1;
        }

        if (this.clientSuggestedDifficulty == null) {
            //console.log(`Setting difficulty to ${this.sessionDifficulty}`)
            const setDifficulty = JSON.stringify(new SuggestDifficulty().response(this.sessionDifficulty));
            const success = await this.write(setDifficulty + '\n');
            if (!success) {
                return;
            }
        }

        // Elektron Net: each miner needs its own getblocktemplate call with its
        // payout address (UTXO attestation is bound to the coinbase output).
        // Subscribe to the node's new-block stream and also refresh on a timer so
        // jobs don't go stale between blocks.
        this.stratumSubscription = this.bitcoinRpcService.newBlock$.subscribe(async () => {
            try {
                await this.refreshMiningJob();
            } catch (e) {
                await this.socket.end();
                console.error(e);
            }
        });

        // Tunable cadences for vardiff re-evaluation and template refresh.
        // High-end ASICs (Bitaxe Gamma, Antminer, Whatsminer) benefit from a
        // shorter template refresh because they exhaust the (nonce, version)
        // search space inside a single ntime window — a faster tick keeps the
        // ntime advancing so they don't waste hashes on stale headers. Both
        // values are env-overridable and clamped to sane minimums so a typo
        // can't drop the pool into a tight spin loop.
        const difficultyCheckMs = this.getTunedIntervalMs('DIFFICULTY_CHECK_INTERVAL_MS', 60 * 1000, 5 * 1000);
        const jobRefreshMs = this.getTunedIntervalMs('JOB_REFRESH_INTERVAL_MS', 30 * 1000, 1 * 1000);

        this.backgroundWork.push(
            setInterval(async () => {
                await this.checkDifficulty();
            }, difficultyCheckMs)
        );

        this.backgroundWork.push(
            setInterval(async () => {
                try {
                    await this.refreshMiningJob();
                } catch (e) {
                    console.error(`Periodic template refresh failed for ${this.clientAuthorization?.address}: ${e?.message ?? e}`);
                }
            }, jobRefreshMs)
        );

    }

    private async refreshMiningJob() {
        if (!this.clientAuthorization?.address) {
            return;
        }
        const jobTemplate = await this.stratumV1JobsService.buildTemplateFor(this.getPoolWalletAddress());
        if (jobTemplate.blockData.clearJobs) {
            this.miningSubmissionHashes.clear();
        }
        await this.sendNewMiningJob(jobTemplate);
    }

    private getPoolWalletAddress(): string {
        // PPLNS: every miner's coinbase pays the shared pool wallet, not the
        // miner directly. The reward is later split among all miners who
        // contributed shares in the PPLNS window (see RewardCalculatorService).
        // This also means all miners share the identical coinbase, which is
        // what makes a future shared-template optimization possible (concept
        // doc §3.2b) even though this version still fetches one template per
        // connected miner.
        const address = this.configService.get<string>('POOL_WALLET_ADDRESS');
        if (!address) {
            throw new Error('POOL_WALLET_ADDRESS is not configured');
        }
        return address;
    }

    private async sendNewMiningJob(jobTemplate: IJobTemplate) {

        // Elektron Net: the UTXO attestation hash committed to in the template's
        // coinbase is computed against a single payout output. Multiple outputs
        // (e.g. an on-chain dev-fee split) would change the coinbase and break
        // the attestation, so the pool fee (if any) is deducted purely by
        // accounting during PPLNS payout (see RewardCalculatorService), never
        // as a second coinbase output.
        this.noFee = true;
        if (this.entity) {
            this.hashRate = this.statistics.hashRate;
        }
        const payoutInformation = [
            { address: this.getPoolWalletAddress(), percent: 100 }
        ];

        const networkConfig = this.configService.get('NETWORK');
        let network: bitcoinjs.networks.Network;

        if (networkConfig === 'mainnet') {
            network = elektronMainnet;
        } else if (networkConfig === 'regtest') {
            network = elektronRegtest;
        } else if (networkConfig === 'bitcoin-mainnet') {
            // Escape hatch for testing against an upstream Bitcoin Core node.
            network = bitcoinjs.networks.bitcoin;
        } else if (networkConfig === 'bitcoin-testnet') {
            network = bitcoinjs.networks.testnet;
        } else if (networkConfig === 'bitcoin-regtest') {
            network = bitcoinjs.networks.regtest;
        } else {
            throw new Error('Invalid network configuration');
        }

        const job = new MiningJob(
            this.configService,
            network,
            this.stratumV1JobsService.getNextId(),
            payoutInformation,
            jobTemplate
        );

        this.stratumV1JobsService.addJob(job);


        const success = await this.write(job.response(jobTemplate));
        if (!success) {
            return;
        }
        this.lastSentMiningJobTimestamp = jobTemplate.block.timestamp;


        //console.log(`Sent new job to ${this.clientAuthorization.worker}.${this.extraNonceAndSessionId}. (clearJobs: ${jobTemplate.blockData.clearJobs}, fee?: ${!this.noFee})`)

    }


    private async ensureClientEntity() {
        if (this.entity != null) {
            return;
        }

        if (this.creatingEntity == null) {
            this.creatingEntity = (async () => {
                this.entity = await this.clientService.insert({
                    sessionId: this.extraNonceAndSessionId,
                    address: this.clientAuthorization.address,
                    clientName: this.clientAuthorization.worker,
                    userAgent: this.clientSubscription.userAgent,
                    startTime: new Date(),
                    bestDifficulty: 0
                });
            })();
        }

        await this.creatingEntity;
    }

    private async handleMiningSubmission(submission: MiningSubmitMessage) {

        const job = this.stratumV1JobsService.getJobById(submission.jobId);

        // a miner may submit a job that doesn't exist anymore if it was removed by a new block notification (or expired, 5 min)
        if (job == null) {
            const err = new StratumErrorMessage(
                submission.id,
                eStratumErrorCode.JobNotFound,
                'Job not found').response();
            //console.log(err);
            const success = await this.write(err);
            if (!success) {
                return false;
            }
            return false;
        }
        const jobTemplate = this.stratumV1JobsService.getJobTemplateById(job.jobTemplateId);

        if (jobTemplate == null) {
            const err = new StratumErrorMessage(
                submission.id,
                eStratumErrorCode.JobNotFound,
                'Job Template not found').response();
            //console.log(err);
            const success = await this.write(err);
            if (!success) {
                return false;
            }
            return false;
        }

        const submissionHash = [
            submission.jobId,
            submission.extraNonce2,
            submission.ntime,
            submission.nonce,
            submission.versionMask ?? ''
        ].join(':');
        if (this.miningSubmissionHashes.has(submissionHash)) {
            const err = new StratumErrorMessage(
                submission.id,
                eStratumErrorCode.DuplicateShare,
                'Duplicate share').response();
            const success = await this.write(err);
            if (!success) {
                return false;
            }
            return false;
        } else {
            this.miningSubmissionHashes.add(submissionHash);
        }

        const versionMask = parseInt(submission.versionMask, 16);
        const nonce = parseInt(submission.nonce, 16);
        const timestamp = parseInt(submission.ntime, 16);

        const header = job.buildHeaderBuffer(
            jobTemplate,
            versionMask,
            nonce,
            this.extraNonceAndSessionId,
            submission.extraNonce2,
            timestamp
        );
        const { submissionDifficulty } = this.calculateDifficulty(header);

        // DIAGNOSTIC (gated behind DIAGNOSTIC_SHARE_LOGGING_MODES env var):
        // Some hobby firmwares (NerdMiner V2, older Bitaxe builds, etc.)
        // mangle the coinbase in non-spec ways before computing the merkle
        // root. The pool's canonical coinbase is byte-exact to miner.py
        // (required for UTXO attestation), so when a firmware's merkle root
        // diverges, every share reads as diff~0 against the pool's view.
        //
        // Each enabled mode reconstructs the header under one specific
        // hypothesis about what the firmware splices into the coinbase, and
        // we log the resulting difficulty side by side. If exactly one
        // hypothesis consistently produces diff >= required while canonical
        // stays ~0, we've identified the firmware's mangling — and can then
        // decide whether it's pool-fixable or needs a firmware patch.
        //
        // Env value is a comma-separated list of mode codes. Empty or unset
        // disables all diagnostic output. Special value `all` enables every
        // mode. Available modes:
        //
        //   canonical            no splice (== the value used for share OK check)
        //   suffix-en1           canonical || extranonce1
        //   suffix-en1-en2       canonical || extranonce1 || extranonce2  (classic Stratum)
        //   suffix-zero4         canonical || 0x00000000                  (hardcoded extranonce)
        //   suffix-zero8         canonical || 0x0000000000000000
        //   prefix-en1           extranonce1 || canonical                 (splice at start)
        //   suffix-en1-reversed  canonical || byte-reversed extranonce1   (endianness bug)
        //   scriptsig-en1        extranonce1 spliced inside vin[0].scriptSig (spec-compliant splice)
        const enabledModes = this.parseDiagnosticModes(
            this.configService.get<string>('DIAGNOSTIC_SHARE_LOGGING_MODES'),
        );
        if (enabledModes.size > 0) {
            const en1 = (this.extraNonceAndSessionId && this.extraNonceAndSessionId.length > 0)
                ? Buffer.from(this.extraNonceAndSessionId, 'hex')
                : Buffer.alloc(0);
            const en2 = (submission.extraNonce2 && submission.extraNonce2.length > 0)
                ? Buffer.from(submission.extraNonce2, 'hex')
                : Buffer.alloc(0);
            const en1Reversed = Buffer.from(en1).reverse();
            const zero4 = Buffer.alloc(4);
            const zero8 = Buffer.alloc(8);

            const parts: string[] = [];
            const probe = (label: string, fn: () => Buffer | null) => {
                try {
                    const h = fn();
                    const d = h ? this.calculateDifficulty(h).submissionDifficulty : 0;
                    parts.push(`${label}=${d.toFixed(8)}`);
                } catch (e) {
                    parts.push(`${label}=err:${(e as Error)?.message ?? 'unknown'}`);
                }
            };

            if (enabledModes.has('canonical')) {
                parts.push(`canonical=${submissionDifficulty.toFixed(8)}`);
            }
            if (enabledModes.has('suffix-en1')) {
                probe('suffix-en1', () => job.buildHeaderBufferWithCoinbaseSuffix(jobTemplate, versionMask, nonce, en1, timestamp));
            }
            if (enabledModes.has('suffix-en1-en2')) {
                probe('suffix-en1-en2', () => job.buildHeaderBufferWithCoinbaseSuffix(jobTemplate, versionMask, nonce, Buffer.concat([en1, en2]), timestamp));
            }
            if (enabledModes.has('suffix-en1-default-en2')) {
                // NerdMiner v1.8.3 hardcodes mWorker.extranonce2 = "00000001"
                // whenever the pool-advertised extranonce2_size is not 2, 4 or 8
                // (the size=0 case falls into the `else` branch in
                // utils.cpp:222-226). The firmware then hashes:
                //   coinbase = coinb1 || extranonce1 || "00000001" || coinb2
                // regardless of what the pool said. This hypothesis tests that.
                const en2default = Buffer.from('00000001', 'hex');
                probe('suffix-en1-default-en2', () =>
                    job.buildHeaderBufferWithCoinbaseSuffix(jobTemplate, versionMask, nonce, Buffer.concat([en1, en2default]), timestamp),
                );
            }
            if (enabledModes.has('suffix-zero4')) {
                probe('suffix-zero4', () => job.buildHeaderBufferWithCoinbaseSuffix(jobTemplate, versionMask, nonce, zero4, timestamp));
            }
            if (enabledModes.has('suffix-zero8')) {
                probe('suffix-zero8', () => job.buildHeaderBufferWithCoinbaseSuffix(jobTemplate, versionMask, nonce, zero8, timestamp));
            }
            if (enabledModes.has('prefix-en1')) {
                probe('prefix-en1', () => job.buildHeaderBufferWithCoinbasePrefix(jobTemplate, versionMask, nonce, en1, timestamp));
            }
            if (enabledModes.has('suffix-en1-reversed')) {
                probe('suffix-en1-reversed', () => job.buildHeaderBufferWithCoinbaseSuffix(jobTemplate, versionMask, nonce, en1Reversed, timestamp));
            }
            if (enabledModes.has('scriptsig-en1')) {
                probe('scriptsig-en1', () => job.buildHeaderBufferWithScriptSigSplice(jobTemplate, versionMask, nonce, en1, timestamp));
            }

            console.log(`  [diag] ${parts.join(' ')} en1=${this.extraNonceAndSessionId} en2=${submission.extraNonce2 ?? ''}`);
        }

        if (submissionDifficulty >= this.sessionDifficulty) {
            const success = await this.write(JSON.stringify(submission.response()) + '\n');
            if (!success) {
                return false;
            }

            if (submissionDifficulty >= jobTemplate.blockData.networkDifficulty) {
                console.log('!!! BLOCK FOUND !!!');
                const updatedJobBlock = job.copyAndUpdateBlock(
                    jobTemplate,
                    versionMask,
                    nonce,
                    this.extraNonceAndSessionId,
                    submission.extraNonce2,
                    timestamp
                );
                const blockHex = updatedJobBlock.toHex(false);
                const result = await this.bitcoinRpcService.SUBMIT_BLOCK(blockHex);
                // SUBMIT_BLOCK returns 'SUCCESS!' when the node accepted the block
                // (null RPC response per `submitblock`). Any other value is the
                // node's rejection reason (e.g. `bad-utxo-attestation`). Only
                // persist accepted blocks in the Found Blocks table and reset
                // best-difficulty counters on a real win — otherwise rejected
                // attempts would pollute the dashboard.
                if (result === 'SUCCESS!') {
                    await this.blocksService.save({
                        height: jobTemplate.blockData.height,
                        minerAddress: this.clientAuthorization.address,
                        worker: this.clientAuthorization.worker,
                        sessionId: this.extraNonceAndSessionId,
                        blockData: blockHex
                    });

                    await this.notificationService.notifySubscribersBlockFound(this.clientAuthorization.address, jobTemplate.blockData.height, updatedJobBlock, result);
                    await this.addressSettingsService.resetBestDifficultyAndShares();

                    try {
                        // PPLNS: split the actual coinbase value (subsidy + fees) among
                        // everyone who contributed shares in the PPLNS window, minus the
                        // pool fee. minerAddress above is who found it (for statistics
                        // only) — the reward itself is shared, not sent to this miner alone.
                        await this.rewardCalculatorService.processBlockFound(jobTemplate.blockData.height, jobTemplate.blockData.coinbasevalue);
                    } catch (e) {
                        console.error(`PPLNS reward calculation failed for block ${jobTemplate.blockData.height}: ${e?.message ?? e}`);
                    }
                }
            }
            await this.ensureClientEntity();
            try {
                // Credit the share's ACTUAL hash difficulty (not the session-required
                // diff) so hashrate and accumulated-work counters stay honest for
                // miners whose firmware hardware-filters above the pool's session
                // diff. See StratumV1ClientStatistics.addShares for the full
                // rationale.
                await this.statistics.addShares(this.entity, submissionDifficulty);
                // PPLNS share log: independent, fine-grained record used for the
                // reward split above (see concept doc §5.1 — the 10-minute buckets
                // in StratumV1ClientStatistics are too coarse for a 60s block time).
                await this.pplnsShareLogService.record(this.clientAuthorization.address, submissionDifficulty, jobTemplate.blockData.height);
                const now = new Date();
                // only update every minute
                if (this.entity.updatedAt == null || now.getTime() - this.entity.updatedAt.getTime() > 1000 * 60) {
                    await this.clientService.heartbeat(this.entity.address, this.entity.clientName, this.entity.sessionId, this.hashRate, now);
                    this.entity.updatedAt = now;
                }

            } catch (e) {
                console.log(e);
            }

            if (submissionDifficulty > this.entity.bestDifficulty) {
                // Persist best-share updates in their own try/catch so a transient
                // SQLite busy / write conflict never silently leaves the address
                // dashboard stuck on 0. Both writes are idempotent and ordered:
                // the per-session row first, then the per-address aggregate that
                // drives the "Best Submitted Share" widget and the high-score
                // table on the splash page.
                try {
                    await this.clientService.updateBestDifficultyIfHigher(this.extraNonceAndSessionId, submissionDifficulty);
                    this.entity.bestDifficulty = submissionDifficulty;
                    await this.addressSettingsService.updateBestDifficultyIfHigher(this.clientAuthorization.address, submissionDifficulty, this.entity.userAgent);
                    console.log(`new best share ${submissionDifficulty.toFixed(2)} for ${this.clientAuthorization.address} (${this.extraNonceAndSessionId})`);
                } catch (e) {
                    console.error(`Failed to persist best share for ${this.clientAuthorization.address} (${this.extraNonceAndSessionId}): ${e?.message ?? e}`);
                }
            }


            const externalShareSubmissionEnabled: boolean = this.configService.get('EXTERNAL_SHARE_SUBMISSION_ENABLED')?.toLowerCase() == 'true';
            const minimumDifficulty: number = parseFloat(this.configService.get('MINIMUM_DIFFICULTY')) || 1000000000000.0; // 1T
            if (externalShareSubmissionEnabled && submissionDifficulty >= minimumDifficulty) {
                // Submit share to API if enabled
                this.externalSharesService.submitShare({
                    worker: this.clientAuthorization.worker,
                    address: this.clientAuthorization.address,
                    userAgent: this.clientSubscription.userAgent,
                    header: header.toString('hex'),
                    externalPoolName: this.configService.get('POOL_IDENTIFIER') || 'Public-Pool'
                });
            }

        } else {
            const err = new StratumErrorMessage(
                submission.id,
                eStratumErrorCode.LowDifficultyShare,
                'Difficulty too low').response();

            const success = await this.write(err);
            if (!success) {
                return false;
            }

            return false;
        }

        //await this.checkDifficulty();
        return false;

    }

    private async checkDifficulty() {
        const targetDiff = this.statistics.getSuggestedDifficulty(this.sessionDifficulty);
        if (targetDiff == null) {
            return;
        }

        if (targetDiff != this.sessionDifficulty) {
            //console.log(`Adjusting ${this.extraNonceAndSessionId} difficulty from ${this.sessionDifficulty} to ${targetDiff}`);
            this.sessionDifficulty = targetDiff;

            const data = JSON.stringify({
                id: null,
                method: eResponseMethod.SET_DIFFICULTY,
                params: [targetDiff]
            }) + '\n';


            await this.socket.write(data);

            const jobTemplate = await this.stratumV1JobsService.buildTemplateFor(this.getPoolWalletAddress());
            const nextTimestamp = Math.max(
                jobTemplate.block.timestamp,
                Math.floor(Date.now() / 1000),
                (this.lastSentMiningJobTimestamp ?? 0) + 1
            );
            // Clear jobs so the difficulty takes effect without re-sending byte-identical work.
            const refreshedJobTemplate: IJobTemplate = {
                ...jobTemplate,
                block: Object.assign(new bitcoinjs.Block(), jobTemplate.block, {
                    timestamp: nextTimestamp
                }),
                blockData: { ...jobTemplate.blockData, clearJobs: true }
            };
            await this.sendNewMiningJob(refreshedJobTemplate);

        }
    }

    private calculateDifficulty(header: Buffer): { submissionDifficulty: number, submissionHash: string } {

        const hashResult = bitcoinjs.crypto.hash256(header);

        const target = this.le256todouble(hashResult);
        const submissionDifficulty = target === 0 ? Number.POSITIVE_INFINITY : TRUE_DIFF_ONE / target;
        return { submissionDifficulty, submissionHash: hashResult.toString('hex') };
    }


    private le256todouble(target: Buffer): number {

        let number = 0;
        for (let i = target.length - 1; i >= 0; i--) {
            number = number * 256 + target[i];
        }

        return number;
    }

    private getTunedIntervalMs(envKey: string, defaultMs: number, minMs: number): number {
        const raw = this.configService.get<string>(envKey);
        if (raw == null || String(raw).trim() === '') {
            return defaultMs;
        }
        const parsed = parseInt(String(raw), 10);
        if (!Number.isFinite(parsed) || parsed <= 0) {
            return defaultMs;
        }
        return Math.max(parsed, minMs);
    }

    private parseDiagnosticModes(raw: string | undefined): Set<string> {
        // DIAGNOSTIC_SHARE_LOGGING_MODES env values:
        //   ""         -> {} (logging off)
        //   "all"      -> every supported mode
        //   "a,b,c"    -> the named modes (whitespace and case insensitive)
        // Unknown tokens are silently dropped — the StartOS multiselect is
        // the source of truth for valid mode names.
        const ALL_MODES = [
            'canonical',
            'suffix-en1',
            'suffix-en1-en2',
            'suffix-en1-default-en2',
            'suffix-zero4',
            'suffix-zero8',
            'prefix-en1',
            'suffix-en1-reversed',
            'scriptsig-en1',
        ];
        if (!raw) return new Set();
        const tokens = raw.split(',').map(t => t.trim().toLowerCase()).filter(t => t.length > 0);
        if (tokens.length === 0) return new Set();
        if (tokens.includes('all')) return new Set(ALL_MODES);
        return new Set(tokens.filter(t => ALL_MODES.includes(t)));
    }

    private isHobbyMiner(userAgent: string): boolean {
        // Hobby-miner allow-list (NerdMiner V2, Bitaxe, NerdAxe, NerdQAxe,
        // ESP-Miner, ...). Substring-matched case-insensitively against the
        // userAgent reported in mining.subscribe. Configured via the
        // HOBBY_MINER_USER_AGENTS env var (comma-separated).
        const list = this.configService.get<string>('HOBBY_MINER_USER_AGENTS');
        if (!list || list.trim() === '' || !userAgent) {
            return false;
        }
        const needles = list.split(',').map(ua => ua.trim().toLowerCase()).filter(ua => ua.length > 0);
        const haystack = userAgent.toLowerCase();
        return needles.some(needle => haystack.includes(needle));
    }

    private isBlockedUserAgent(userAgent: string): boolean {
        const blockedUserAgents = this.configService.get<string>('NON_COMPLIANT_USER_AGENTS')
            || this.configService.get<string>('BLOCKED_USER_AGENTS')
            || this.configService.get<string>('COMPLIANT_HEADERS');
        if (!blockedUserAgents || blockedUserAgents.trim() === '') {
            return false;
        }

        const blockedList = blockedUserAgents.split(',').map(ua => ua.trim().toLowerCase());
        const userAgentLower = userAgent.toLowerCase();

        return blockedList.some(blocked => blocked.length > 0 && userAgentLower.includes(blocked));
    }

    private logBlockedUserAgent(userAgent: string) {
        const now = Date.now();
        const logState = StratumV1Client.blockedUserAgentLogState.get(userAgent);

        if (logState != null && now < logState.nextLogAt) {
            logState.suppressed += 1;
            return;
        }

        const suppressed = logState?.suppressed ?? 0;
        const suffix = suppressed > 0 ? ` (${suppressed} similar connections suppressed)` : '';
        console.log(`Blocked non-compliant connection from userAgent: ${userAgent}${suffix}`);
        StratumV1Client.blockedUserAgentLogState.set(userAgent, {
            nextLogAt: now + BLOCKED_USER_AGENT_LOG_INTERVAL_MS,
            suppressed: 0
        });
    }

    private logValidationError(label: string, errors: ValidationError[]) {
        const now = Date.now();
        const signature = this.getValidationErrorSignature(errors);
        const sample = this.getValidationErrorSample(errors);
        const key = `${label}:${signature}`;
        const logState = StratumV1Client.validationErrorLogState.get(key);

        if (logState != null && now < logState.nextLogAt) {
            logState.suppressed += 1;
            return;
        }

        const suppressed = logState?.suppressed ?? 0;
        const suffix = suppressed > 0 ? ` (${suppressed} similar validation errors suppressed)` : '';
        console.warn(`${label}: ${signature}${sample}${suffix}`);
        StratumV1Client.validationErrorLogState.set(key, {
            nextLogAt: now + VALIDATION_ERROR_LOG_INTERVAL_MS,
            suppressed: 0,
            sample
        });
    }

    private getValidationErrorSignature(errors: ValidationError[]): string {
        if (errors.length === 0) {
            return 'unknown';
        }

        return errors.map(error => {
            const constraints = Object.keys(error.constraints ?? {}).sort().join('|') || 'invalid';
            return `${error.property}:${constraints}`;
        }).join(';');
    }

    private getValidationErrorSample(errors: ValidationError[]): string {
        const values = errors
            .map(error => error.value)
            .filter(value => value != null)
            .map(value => String(value).replace(/[\r\n]/g, '').slice(0, 64));

        if (values.length === 0) {
            return '';
        }

        return ` sample=${values.join(',')}`;
    }

    private closeSocket() {
        this.connectionClosed = true;
        if (!this.socket.destroyed) {
            this.socket.destroy();
        }
    }

    private async write(message: string): Promise<boolean> {
        try {
            if (!this.socket.destroyed && !this.socket.writableEnded) {

                await new Promise((resolve, reject) => {
                    this.socket.write(message, (error) => {
                        if (error) {
                            reject(error);
                        } else {
                            resolve(true);
                        }
                    });
                });

                return true;
            } else {
                console.error(`Error: Cannot write to closed or ended socket. ${this.extraNonceAndSessionId} ${message}`);
                this.destroy();
                if (!this.socket.destroyed) {
                    this.socket.destroy();
                }
                return false;
            }
        } catch (error) {
            this.destroy();
            if (!this.socket.writableEnded) {
                await this.socket.end();
            } else if (!this.socket.destroyed) {
                this.socket.destroy();
            }
            console.error(`Error occurred while writing to socket: ${this.extraNonceAndSessionId}`, error);
            return false;
        }
    }

}
