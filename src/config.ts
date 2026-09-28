import fs from 'node:fs/promises';
import path from 'node:path';
import { isWorkspaceContainedPath } from './utils/paths.ts';
import { mergeArrays } from './utils/arrays.ts';
import { clamp, firstFiniteNumber, parseBoolean, parseLogLevel, readEnv, type LogLevel } from './utils/values.ts';
import { setDebugLogLevel } from './utils/io.ts';

export { clamp, type LogLevel } from './utils/values.ts';

/**
 * jev: TypeSafe Jev scores + structural heuristics (default; sends diffs and test titles to the TypeSafe API).
 * heuristics: structural heuristics only (fully local).
 */
export type Ranker = 'jev' | 'heuristics';
export type SelectionPolicy = 'adaptive' | 'conservative' | 'targeted';

export interface MatchDefaults {
    topK?: number;
    threshold: number;
    minScore: number;
    selectionPolicy: SelectionPolicy;
    candidatePaths: string[];
    includePatterns: string[];
    excludePatterns: string[];
}

export interface AppConfig {
    ranker?: Ranker;
    jevModel?: string;
    jevProvider?: string;
    cacheDir?: string;
    logLevel?: LogLevel;
    quiet?: boolean;
    verbose?: boolean;
    match?: Partial<MatchDefaults>;
}

export interface RuntimeConfig {
    ranker: Ranker;
    jevModel: string;
    jevProvider: string;
    cacheDir: string;
    logLevel: LogLevel;
    quiet: boolean;
    verbose: boolean;
    match: MatchDefaults;
    configFile?: string;
}

export interface RootOptions {
    config?: string;
    cacheDir?: string;
    logLevel?: string;
    verbose?: boolean;
    quiet?: boolean;
}

export interface MatchCommandOptions {
    threshold?: string;
    topK?: string;
    minScore?: string;
    selectionPolicy?: string;
    candidates?: string[];
    includeFile?: string[];
    excludeFile?: string[];
    ranker?: string;
    jevModel?: string;
    jevProvider?: string;
    cacheDir?: string;
    json?: boolean;
}

const DEFAULT_CONFIG = {
    ranker: 'jev',
    // Pinned so cached answers and tuned thresholds survive `jev-latest` moving.
    jevModel: 'jev-1.13.0',
    cacheDir: '.rbt/cache',
    logLevel: 'info',
    match: {
        threshold: 0,
        minScore: 0,
        selectionPolicy: 'adaptive',
        candidatePaths: ['test', 'tests'],
        includePatterns: ['**/*'],
        excludePatterns: ['**/dist/**', '**/.git/**', '**/node_modules/**', '**/build/**']
    },
} satisfies AppConfig;

function parseRanker(value: unknown): Ranker {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (normalized === 'jev' || normalized === 'heuristics') {
        return normalized;
    }

    throw new Error(`Invalid ranker "${value}". Expected "jev" or "heuristics".`);
}

function parseSelectionPolicy(value: unknown): SelectionPolicy {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (normalized === 'adaptive' || normalized === 'conservative' || normalized === 'targeted') {
        return normalized;
    }
    throw new Error(`Invalid selection policy "${value}". Expected "adaptive", "conservative", or "targeted".`);
}

function parseJsonConfig(raw: string, filePath: string): AppConfig {
    try {
        const parsed = JSON.parse(raw) as AppConfig;
        return typeof parsed === 'object' && parsed !== null ? parsed : {};
    } catch (error) {
        throw new Error(`Failed to parse config file ${filePath}: ${(error as Error).message}`);
    }
}

// An auto-discovered config comes from the repo being tested, so it must not reach outside it.
async function assertInsideWorkspace(paths: string[], workspace: string, setting: string): Promise<void> {
    const contained = await Promise.all(
        paths.map((configuredPath) => isWorkspaceContainedPath(path.resolve(workspace, configuredPath), workspace))
    );
    if (contained.includes(false)) {
        throw new Error(`Auto-discovered repo config cannot set ${setting} outside the workspace.`);
    }
}

export interface LoadedConfig {
    config: AppConfig;
    autoDiscovered: boolean;
    filePath?: string;
}

export async function loadConfig(configPath?: string): Promise<LoadedConfig> {
    const candidates = configPath
        ? [{ filePath: configPath, autoDiscovered: false }]
        : [
            { filePath: path.join(process.cwd(), '.rbt', 'config.json'), autoDiscovered: true },
            { filePath: path.join(process.cwd(), '.rbtconfig'), autoDiscovered: true },
        ];

    for (const candidate of candidates) {
        try {
            const raw = await fs.readFile(candidate.filePath, 'utf8');
            return {
                config: parseJsonConfig(raw, candidate.filePath),
                autoDiscovered: candidate.autoDiscovered,
                filePath: candidate.filePath,
            };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
            }
        }
    }

    return { config: {}, autoDiscovered: false };
}

export async function resolveConfig(
    rootOptions: RootOptions,
    commandOptions: MatchCommandOptions,
    cwd: string = process.cwd()
): Promise<RuntimeConfig> {
    const { config: fileConfig, autoDiscovered, filePath: configFile } = await loadConfig(rootOptions.config);
    const fileMatch = fileConfig.match ?? {};
    const matchDefaults = DEFAULT_CONFIG.match;
    const workspace = path.resolve(cwd);
    const env = process.env;

    // Every setting resolves as: CLI flag, then RBT_* environment variable, then config file, then default.
    const ranker = parseRanker(commandOptions.ranker ?? readEnv('RBT_RANKER') ?? fileConfig.ranker ?? DEFAULT_CONFIG.ranker);
    const jevModel = commandOptions.jevModel ?? readEnv('RBT_JEV_MODEL') ?? fileConfig.jevModel ?? DEFAULT_CONFIG.jevModel;
    const jevProvider = (commandOptions.jevProvider ?? readEnv('JEV_PROVIDER') ?? fileConfig.jevProvider ?? 'auto').trim().toLowerCase();
    const logLevel = parseLogLevel(
        rootOptions.logLevel ?? readEnv('RBT_LOG_LEVEL') ?? fileConfig.logLevel ?? DEFAULT_CONFIG.logLevel
    );
    setDebugLogLevel(logLevel === 'debug');
    const quiet = parseBoolean(rootOptions.quiet ?? readEnv('RBT_QUIET') ?? fileConfig.quiet);
    const verbose = parseBoolean(rootOptions.verbose ?? readEnv('RBT_VERBOSE') ?? fileConfig.verbose);

    // Numbers also accept RBT_MATCH_* aliases; firstFiniteNumber skips blank and unparsable values.
    const configuredTopK = firstFiniteNumber(commandOptions.topK, env.RBT_TOP_K, env.RBT_MATCH_TOP_K, fileMatch.topK);
    const configuredThreshold = firstFiniteNumber(
        commandOptions.threshold, env.RBT_THRESHOLD, env.RBT_MATCH_THRESHOLD, fileMatch.threshold
    );
    const threshold = clamp(configuredThreshold ?? matchDefaults.threshold, 0, 1);
    const configuredMinScore = firstFiniteNumber(
        commandOptions.minScore, env.RBT_MIN_SCORE, env.RBT_MATCH_MIN_SCORE, fileMatch.minScore
    );
    const selectionPolicy = parseSelectionPolicy(
        commandOptions.selectionPolicy ?? readEnv('RBT_SELECTION_POLICY') ??
            fileMatch.selectionPolicy ?? matchDefaults.selectionPolicy
    );

    // The match command's --cache-dir outranks the global one.
    const cacheDirOverride = commandOptions.cacheDir ?? rootOptions.cacheDir ?? readEnv('RBT_CACHE_DIR');
    if (autoDiscovered && cacheDirOverride == null && fileConfig.cacheDir) {
        await assertInsideWorkspace([fileConfig.cacheDir], workspace, 'cacheDir');
    }

    const cliCandidates = commandOptions.candidates?.length ? commandOptions.candidates : undefined;
    if (autoDiscovered && !cliCandidates && fileMatch.candidatePaths) {
        await assertInsideWorkspace(fileMatch.candidatePaths, workspace, 'candidate paths');
    }

    return {
        ranker,
        jevModel,
        jevProvider,
        cacheDir: path.resolve(cwd, cacheDirOverride ?? fileConfig.cacheDir ?? DEFAULT_CONFIG.cacheDir),
        logLevel,
        quiet,
        verbose,
        match: {
            topK: configuredTopK === undefined ? undefined : Math.floor(clamp(configuredTopK, 1, 1000)),
            threshold,
            minScore: clamp(configuredMinScore ?? threshold, 0, 1),
            selectionPolicy,
            candidatePaths: cliCandidates ?? fileMatch.candidatePaths ?? matchDefaults.candidatePaths,
            // CLI includes replace the configured ones; CLI excludes add to them.
            includePatterns: commandOptions.includeFile?.length
                ? commandOptions.includeFile
                : fileMatch.includePatterns ?? matchDefaults.includePatterns,
            excludePatterns: mergeArrays(commandOptions.excludeFile, fileMatch.excludePatterns ?? matchDefaults.excludePatterns),
        },
        configFile,
    };
}
