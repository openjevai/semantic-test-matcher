import path from 'node:path';
import { isProbability } from '../utils/values.ts';
import { buildCacheKey, loadCache, writeCacheEntries } from './cache.ts';
import type { DocumentProfile } from './document-profile.ts';
import { mapWithConcurrency, sleep } from '../utils/async.ts';
import { isDebug } from '../utils/io.ts';

export const JEV_PROVIDER = 'typesafe';
export const JEV_API_KEY_ENV = 'TYPESAFE_API_KEY';
export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

// OpenJEV — a free community gateway to the same Jev model (https://openjev.sh).
// Used only when explicitly chosen or when no TypeSafe key is set; TypeSafe stays the default.
export const OPENJEV_PROVIDER = 'openjev';
export const OPENJEV_API_KEY_ENV = 'OPENJEV_API_KEY';
export const OPENJEV_ENDPOINT = 'https://api.openjev.sh/v1/systemone';
export const OPENJEV_MODEL = 'openjev';

export type JevProviderName = 'typesafe' | 'openjev';

export interface JevProviderConfig {
    name: JevProviderName;
    endpoint: string;
    apiKeyEnv: string;
    model: string;
}

/**
 * Resolves which Jev provider to use. TypeSafe is the default and stays unchanged
 * for anyone with a `TYPESAFE_API_KEY`. OpenJEV is used only when explicitly chosen
 * (`JEV_PROVIDER=openjev`) or when only `OPENJEV_API_KEY` is set.
 */
export function resolveJevProvider(explicit: string | undefined, model: string): JevProviderConfig {
    if (explicit === 'openjev') {
        return { name: 'openjev', endpoint: OPENJEV_ENDPOINT, apiKeyEnv: OPENJEV_API_KEY_ENV, model: OPENJEV_MODEL };
    }
    if (explicit === 'typesafe') {
        return { name: 'typesafe', endpoint: JEV_ENDPOINT, apiKeyEnv: JEV_API_KEY_ENV, model };
    }
    // Auto: TypeSafe if its key is set (default unchanged), otherwise OpenJEV if its key is set.
    if (process.env[JEV_API_KEY_ENV]) {
        return { name: 'typesafe', endpoint: JEV_ENDPOINT, apiKeyEnv: JEV_API_KEY_ENV, model };
    }
    if (process.env[OPENJEV_API_KEY_ENV]) {
        return { name: 'openjev', endpoint: OPENJEV_ENDPOINT, apiKeyEnv: OPENJEV_API_KEY_ENV, model: OPENJEV_MODEL };
    }
    // Default to TypeSafe so existing error messages are unchanged.
    return { name: 'typesafe', endpoint: JEV_ENDPOINT, apiKeyEnv: JEV_API_KEY_ENV, model };
}

const MAX_DIFF_CHARS = 8000;
const MAX_SOURCE_CHARS = 6000;
const MAX_EXPORTED_SYMBOLS = 20;
const MAX_TEST_TITLES = 40;
// One request must stay inside Jev's 64k-token budget (state plus every question), with headroom.
const MAX_REQUEST_TOKENS = 60_000;
const MAX_QUESTIONS_PER_REQUEST = 250;
const REQUEST_CONCURRENCY = 4;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 5;
const MAX_RETRY_AFTER_MS = 30_000;

const QUESTION_WITH_DIFF = 'Should the tests in `test_file` be re-run to check the code change shown in `changed_file`?';
const QUESTION_WITHOUT_DIFF = 'Do the tests in `test_file` exercise the behavior implemented in `changed_file`?';
const CRITERIA = {
    true: 'The tests in `test_file` exercise behavior that `changed_file` implements, so the change could alter whether they pass.',
    false: 'The tests in `test_file` cover other features; `changed_file` does not plausibly affect their outcome.',
};

export interface JevSource {
    profile: DocumentProfile;
    text: string;
    /** A diff was supplied for this file, so only its hunks may be sent, never its source. */
    diffOnly?: boolean;
}

export interface JevCandidate {
    file: string;
    profile: DocumentProfile;
}

export interface JevScorerOptions {
    apiKey: string;
    model: string;
    cacheDir: string;
    skipCache?: boolean;
    fetch?: typeof fetch;
    retryBaseMs?: number;
    /** Provider name used in cache keys. Defaults to 'typesafe'. */
    provider?: JevProviderName;
    /** API endpoint. Defaults to the TypeSafe endpoint. */
    endpoint?: string;
    /** Env var name used in error messages. Defaults to TYPESAFE_API_KEY. */
    apiKeyEnv?: string;
}

export interface JevScoreResult {
    scores: Map<string, number>;
    /** HTTP requests sent, retries included. */
    requests: number;
    cacheHits: number;
    inputTokens: number;
    /** Every model version whose answers were used, cached answers included, sorted. */
    models: string[];
}

interface JevNoulQuestion {
    type: 'noul';
    instructions: { test_file: { path: string; test_titles: string[] }; question: string };
    criteria: typeof CRITERIA;
}

interface JevResponse {
    model: string;
    answers: Record<string, { type: string; noul?: number }>;
    usage?: { input_tokens?: number; output_tokens?: number };
}

type JevAttempt = { response: JevResponse } | { failure: string; retryAfterMs: number };

interface CachedJevAnswer {
    createdAt: string;
    provider: string;
    model: string;
    noul: number;
}

export class JevError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'JevError';
    }
}

export function getJevCacheFile(cacheDirectory: string): string {
    return path.join(cacheDirectory, 'jev.json');
}

export async function getJevCacheEntryCount(cacheDirectory: string): Promise<number> {
    try {
        return Object.keys(await loadCache<CachedJevAnswer>(getJevCacheFile(cacheDirectory))).length;
    } catch {
        // Cache statistics are best-effort and must not fail an otherwise successful match.
        return 0;
    }
}

function truncate(text: string, maxChars: number): string {
    return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n…(truncated)`;
}

export function buildJevState(source: JevSource): { changed_file: Record<string, unknown> } {
    const changedFile: Record<string, unknown> = {
        path: source.profile.relativePath,
        exported_symbols: source.profile.exports.slice(0, MAX_EXPORTED_SYMBOLS),
    };
    if (source.profile.diffExcerpt) {
        changedFile.diff = truncate(source.profile.diffExcerpt, MAX_DIFF_CHARS);
    } else if (!source.diffOnly) {
        // Drop a leading license/doc block so the excerpt spends its budget on code.
        changedFile.source_code = truncate(source.text.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, ''), MAX_SOURCE_CHARS);
    }
    return { changed_file: changedFile };
}

export function buildJevQuestion(source: JevSource, candidate: JevCandidate): JevNoulQuestion {
    return {
        type: 'noul',
        instructions: {
            test_file: {
                path: candidate.file,
                test_titles: candidate.profile.testTitles.slice(0, MAX_TEST_TITLES),
            },
            question: source.profile.diffExcerpt ? QUESTION_WITH_DIFF : QUESTION_WITHOUT_DIFF,
        },
        criteria: CRITERIA,
    };
}

/** An upper bound on tokens: byte-level tokenizers never emit more than one token per UTF-8 byte. */
export function estimateTokens(text: string): number {
    return Buffer.byteLength(text);
}

function batchQuestions(indices: number[], questions: JevNoulQuestion[], tokenBudget: number): number[][] {
    const batches: number[][] = [];
    let current: number[] = [];
    let currentTokens = 0;

    for (const index of indices) {
        const size = estimateTokens(JSON.stringify(questions[index]));
        if (
            current.length &&
            (current.length >= MAX_QUESTIONS_PER_REQUEST || currentTokens + size > tokenBudget)
        ) {
            batches.push(current);
            current = [];
            currentTokens = 0;
        }
        current.push(index);
        currentTokens += size;
    }

    if (current.length) {
        batches.push(current);
    }
    return batches;
}

function isRetryableStatus(status: number): boolean {
    return status === 408 || status === 429 || status >= 500;
}

function describeFailure(status: number, body: string, apiKeyEnv: string): string {
    const hint = status === 401 || status === 403 ? `; check ${apiKeyEnv}` : '';
    return `HTTP ${status}${hint}: ${body.slice(0, 200)}`;
}

/** Retry-After is either delay-seconds or an HTTP date; anything else means no hint. */
function parseRetryAfterMs(header: string | null): number {
    const seconds = Number(header ?? 0);
    return Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header ?? '') - Date.now();
}

// Honors the server's Retry-After (capped) but never waits less than exponential backoff.
function retryDelayMs(attempt: number, retryAfterMs: number, retryBaseMs: number): number {
    return Math.max(
        Math.min(Number.isFinite(retryAfterMs) ? retryAfterMs : 0, MAX_RETRY_AFTER_MS),
        retryBaseMs * 2 ** (attempt - 1)
    );
}

/** A 200 body can still be `null`, another non-object, or miss the answering model, e.g. from a proxy. */
function isJevResponse(value: unknown): value is JevResponse {
    return typeof value === 'object' && value !== null
        && 'answers' in value && typeof value.answers === 'object' && value.answers !== null
        && 'model' in value && typeof value.model === 'string' && value.model !== '';
}

// Batch questions are keyed by candidate index so answers map back to candidates.
function questionId(index: number): string {
    return `t${index}`;
}

/** Asks Jev, once per candidate test file, whether it should re-run for a change; answers are cached. */
export class JevScorer {
    private cachePromise?: Promise<Record<string, CachedJevAnswer>>;
    private pending: Record<string, CachedJevAnswer> = {};
    private readonly options: JevScorerOptions;
    private readonly cacheFile: string;
    private readonly fetchImpl: typeof fetch;
    private readonly provider: JevProviderName;
    private readonly endpoint: string;
    private readonly apiKeyEnv: string;

    constructor(options: JevScorerOptions) {
        this.provider = options.provider ?? JEV_PROVIDER;
        this.endpoint = options.endpoint ?? JEV_ENDPOINT;
        this.apiKeyEnv = options.apiKeyEnv ?? JEV_API_KEY_ENV;
        if (!options.apiKey) {
            throw new JevError(`${this.apiKeyEnv} is required for the jev ranker`);
        }
        this.options = options;
        this.cacheFile = getJevCacheFile(options.cacheDir);
        this.fetchImpl = options.fetch ?? fetch;
    }

    private getCache(): Promise<Record<string, CachedJevAnswer>> {
        this.cachePromise ??= loadCache<CachedJevAnswer>(this.cacheFile).catch((error) => {
            if (isDebug()) {
                console.warn(`Jev cache read failed: ${(error as Error).message}`);
            }
            return {};
        });
        return this.cachePromise;
    }

    async score(source: JevSource, candidates: JevCandidate[]): Promise<JevScoreResult> {
        const state = buildJevState(source);
        const questions = candidates.map((candidate) => buildJevQuestion(source, candidate));
        const keys = questions.map((question) =>
            buildCacheKey(this.provider, this.options.model, JSON.stringify({ state, question }))
        );
        const cache = this.options.skipCache ? {} : await this.getCache();
        const scores = new Map<string, number>();
        const models = new Set<string>();
        const uncached: number[] = [];

        keys.forEach((key, index) => {
            const hit = this.pending[key] ?? cache[key];
            // An answer from any other model than the one requested came through a moving alias.
            if (hit?.model === this.options.model && isProbability(hit.noul)) {
                scores.set(candidates[index].file, hit.noul);
                models.add(hit.model);
            } else {
                uncached.push(index);
            }
        });

        const result: JevScoreResult = {
            scores,
            requests: 0,
            cacheHits: candidates.length - uncached.length,
            inputTokens: 0,
            models: [],
        };

        try {
            const questionTokenBudget = MAX_REQUEST_TOKENS - estimateTokens(JSON.stringify(state));
            const batches = batchQuestions(uncached, questions, questionTokenBudget);
            await mapWithConcurrency(batches, REQUEST_CONCURRENCY, async (batch) => {
                const { response, attempts } = await this.request({
                    state,
                    questions: Object.fromEntries(batch.map((index) => [questionId(index), questions[index]])),
                });
                result.requests += attempts;
                result.inputTokens += response.usage?.input_tokens ?? 0;
                models.add(response.model);

                for (const index of batch) {
                    const noul = response.answers[questionId(index)]?.noul;
                    if (!isProbability(noul)) {
                        throw new JevError(`Jev response has no answer for ${candidates[index].file}`);
                    }
                    scores.set(candidates[index].file, noul);
                    // A moving alias such as `jev-latest` answers as the version it names today, so only pinned answers are cached.
                    if (!this.options.skipCache && response.model === this.options.model) {
                        this.pending[keys[index]] = {
                            createdAt: new Date().toISOString(),
                            provider: this.provider,
                            model: response.model,
                            noul,
                        };
                    }
                }
            });
        } catch (error) {
            await this.flush();
            throw error;
        }

        result.models = [...models].sort();
        return result;
    }

    private async request(body: {
        state: ReturnType<typeof buildJevState>;
        questions: Record<string, JevNoulQuestion>;
    }): Promise<{ response: JevResponse; attempts: number }> {
        const payload = JSON.stringify({ model: this.options.model, ...body });
        const retryBaseMs = this.options.retryBaseMs ?? 500;

        for (let attempt = 1; ; attempt += 1) {
            const outcome = await this.attempt(payload);
            if ('response' in outcome) {
                return { response: outcome.response, attempts: attempt };
            }
            if (attempt >= MAX_ATTEMPTS) {
                throw new JevError(`Jev request failed after ${attempt} attempts (${outcome.failure})`);
            }
            if (isDebug()) {
                console.warn(`Jev request attempt ${attempt} failed (${outcome.failure}); retrying`);
            }
            await sleep(retryDelayMs(attempt, outcome.retryAfterMs, retryBaseMs));
        }
    }

    /** Sends one request. Retryable failures are returned; others throw JevError. */
    private async attempt(payload: string): Promise<JevAttempt> {
        try {
            const response = await this.fetchImpl(this.endpoint, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${this.options.apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: payload,
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
            if (response.ok) {
                const body: unknown = await response.json();
                // score() still checks each answer's noul before use.
                return isJevResponse(body)
                    ? { response: body }
                    : { failure: 'response has no answers or model', retryAfterMs: 0 };
            }
            const failure = describeFailure(response.status, await response.text(), this.apiKeyEnv);
            if (!isRetryableStatus(response.status)) {
                throw new JevError(`Jev request failed (${failure})`);
            }
            return { failure, retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')) };
        } catch (error) {
            // Network, timeout, and body-read errors are retryable; our own JevError is final.
            if (error instanceof JevError) {
                throw error;
            }
            return { failure: (error as Error).message, retryAfterMs: 0 };
        }
    }

    /** Persists buffered answers in a single locked cache write. Best-effort. */
    async flush(): Promise<void> {
        if (!Object.keys(this.pending).length) {
            return;
        }

        try {
            await writeCacheEntries(this.cacheFile, this.pending);
            this.pending = {};
        } catch (error) {
            if (isDebug()) {
                console.warn(`Jev cache write failed: ${(error as Error).message}`);
            }
        }
    }
}
