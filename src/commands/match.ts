import { Command } from 'commander';
import fs from 'node:fs/promises';
import path from 'node:path';
import { collectCandidateFilesDetailed, isAllowedFile, MAX_CANDIDATE_FILES, readCandidateText } from '../utils/files.ts';
import { parseStdinList, readFileIfExists, readStdinText } from '../utils/io.ts';
import { mapWithConcurrency } from '../utils/async.ts';
import { resolveConfig, type Ranker, type RootOptions, type RuntimeConfig } from '../config.ts';
import {
    getJevCacheEntryCount,
    JevError,
    JevScorer,
    resolveJevProvider,
    type JevScoreResult,
} from '../services/jev.ts';
import {
    filterMatches,
    rankMatches,
    selectMatches,
    TARGETED_JEV_THRESHOLD,
    type MatchCandidate,
    type RankedMatchCandidate,
} from '../services/match.ts';
import { buildDocumentProfile, isTestLike, isTestLikeSource, listDiffFiles, resolveDiffRoot } from '../services/document-profile.ts';
import { readGitChanges } from '../services/git-changes.ts';
import { detectTestCommand, promptAndRunTests } from '../services/test-runner.ts';
import { quoteShellArgument } from '../utils/shell.ts';
import { findPathsOutside } from '../utils/paths.ts';

const READ_CONCURRENCY = 8;

interface MatchOptions {
    threshold?: string;
    minScore?: string;
    topK?: string;
    selectionPolicy?: string;
    candidates?: string[];
    includeFile?: string[];
    excludeFile?: string[];
    ranker?: string;
    jevModel?: string;
    jevProvider?: string;
    cacheDir?: string;
    diffFile?: string;
    diffRoot?: string;
    json?: boolean;
    pathsOnly?: boolean;
    candidatesFromStdin?: boolean;
}

interface ChangedFiles {
    /** No files and no --diff-file: rank local Git changes, then offer to run the tests. */
    automatic: boolean;
    paths: string[];
    diffText?: string;
    diffRoot?: string;
}

type ChangedSource = Awaited<ReturnType<typeof readChangedFile>>;
type ChangeReport = ReturnType<typeof rankChangedFile>;

function collect(value: string, previous: string[] = []): string[] {
    return [...previous, value];
}

export function registerMatchCommand(program: Command): void {
    program
        .command('match')
        .description('Match code change to test cases')
        .argument('[files...]', 'Changed file paths (default: --diff-file changes, or local Git changes followed by a test-command prompt)')
        .option('-t, --threshold <number>', 'Minimum similarity threshold')
        .option('--min-score <number>', 'Minimum similarity score override')
        .option('--top-k <number>', 'Optional maximum number of selected tests')
        .option('--selection-policy <name>', 'adaptive (default), conservative (fixed top five), or targeted (affirmative Jev top five)')
        // Repeatable rather than variadic: a variadic option would swallow changed files that follow it.
        .option('-c, --candidates <pattern>', 'Candidate file path, directory, or file glob (repeat for several)', collect)
        .option('--include-file <pattern>', 'Include only matching files (glob pattern; repeat for several)', collect)
        .option('--exclude-file <pattern>', 'Exclude matching files (glob pattern; repeat for several)', collect)
        .option('--candidates-from-stdin', 'Read candidate file list (JSON array or newline list) from stdin')
        .option('--ranker <name>', `jev (TypeSafe or OpenJEV API, default; key from TYPESAFE_API_KEY or OPENJEV_API_KEY) or heuristics (local only)`)
        .option('--jev-model <id>', 'Jev model id (TypeSafe: jev-1.13.0 default; OpenJEV: openjev)')
        .option('--jev-provider <name>', 'Jev provider: typesafe (default), openjev, or auto (env-based)')
        .option('--cache-dir <path>', 'Directory used to cache Jev answers')
        .option('--diff-file <path>', 'Unified diff file used to enrich change-aware matching')
        .option('--diff-root <path>', 'Base directory for relative paths in --diff-file')
        .option('--json', 'Print machine-readable output')
        .option('--paths-only', 'Print only the selected test paths, one per line')
        .action(async (files: string[], options: MatchOptions) => {
            const config = await resolveMatchConfig(program.opts(), options);
            const cwd = process.cwd();
            const changes = await resolveChangedFiles(files, options, cwd);
            if (!changes.paths.length) {
                if (options.json) console.log(JSON.stringify({ files: [], matched: 0, results: [], changes: [] }));
                else if (!options.pathsOnly && !config.quiet) console.log('No local source changes. Tests not run.');
                return;
            }

            const candidateScan = await collectCandidateFilesDetailed(
                config.match.candidatePaths,
                config.match.includePatterns,
                config.match.excludePatterns,
                cwd,
                changes.automatic ? (file) => isRunnableCandidate(file, cwd) : undefined
            );
            const candidates = await loadCandidates(candidateScan.files, cwd);
            const reports = await matchChangedFiles(changes, candidates, config, candidateScan.truncated, cwd);
            const cacheEntries = await getJevCacheEntryCount(config.cacheDir);
            const selected = mergeSelections(reports);

            if (options.json) {
                printJson(reports, selected, cacheEntries);
                return;
            }
            if (options.pathsOnly) {
                for (const match of selected) {
                    console.log(match.file);
                }
                return;
            }
            printText(reports, selected, config, candidateScan.truncated);
            if (!selected.length) {
                return;
            }
            if (changes.automatic) {
                process.exitCode = await promptAndRunTests(selected.map((match) => match.file), cwd);
            } else if (!config.quiet) {
                const testCommand = await detectTestCommand(cwd);
                if (testCommand) {
                    console.log(`\nRun: ${testCommand} ${selected.map((match) => quoteShellArgument(match.file)).join(' ')}`);
                }
            }
        });
}

async function resolveMatchConfig(rootOptions: RootOptions, options: MatchOptions) {
    const candidatesFromStdin = options.candidatesFromStdin
        ? parseStdinList(await readStdinText())
        : undefined;
    return resolveConfig(
        {
            config: rootOptions.config,
            cacheDir: rootOptions.cacheDir,
            logLevel: rootOptions.logLevel,
            verbose: rootOptions.verbose,
            quiet: rootOptions.quiet,
        },
        {
            threshold: options.threshold,
            minScore: options.minScore,
            topK: options.topK,
            selectionPolicy: options.selectionPolicy,
            candidates: options.candidates?.length ? options.candidates : candidatesFromStdin,
            includeFile: options.includeFile,
            excludeFile: options.excludeFile,
            ranker: options.ranker,
            jevModel: options.jevModel,
            jevProvider: options.jevProvider,
            cacheDir: options.cacheDir,
            json: options.json,
        },
    );
}

async function resolveChangedFiles(files: string[], options: MatchOptions, cwd: string): Promise<ChangedFiles> {
    const automatic = !files.length && !options.diffFile;
    const gitChanges = automatic ? await readGitChanges(cwd) : undefined;
    const diffText = options.diffFile ? await fs.readFile(path.resolve(cwd, options.diffFile), 'utf8') : gitChanges?.diffText;
    const diffRoot = gitChanges?.root ?? options.diffRoot;
    const paths = files.length
        ? files.map((file) => path.resolve(cwd, file))
        : gitChanges ? await keepGitChangesInRoot(gitChanges.files, gitChanges.root, cwd)
            : await listContainedDiffFiles(diffText ?? '', cwd, diffRoot);
    if (!paths.length && !automatic) {
        throw new Error('The --diff-file changes no source files');
    }
    return { automatic, paths, diffText, diffRoot };
}

// Discovered changed files are read and may be sent to Jev, so none may leave its root.
async function listContainedDiffFiles(diffText: string, cwd: string, diffRoot: string | undefined): Promise<string[]> {
    const root = resolveDiffRoot(cwd, diffRoot);
    const files = listDiffFiles(diffText, cwd, diffRoot).filter(isAllowedFile);
    const [outside] = await findPathsOutside(files, root);
    if (outside) {
        throw new Error(`The --diff-file changes ${outside}, which is outside its diff root ${root}`);
    }
    return files;
}

// An untracked symlink to a file elsewhere is common enough to skip rather than fail the run.
async function keepGitChangesInRoot(files: string[], root: string, cwd: string): Promise<string[]> {
    const outside = new Set(await findPathsOutside(files, root));
    for (const file of outside) {
        console.warn(`Warning: skipping ${path.relative(cwd, file)}, which resolves outside the repository`);
    }
    return files.filter((file) => !outside.has(file));
}

// Automatic mode runs its selection, so only test-like files may fill the candidate cap there.
async function isRunnableCandidate(file: string, cwd: string): Promise<boolean> {
    const relativePath = path.relative(cwd, file);
    // A test file name decides it without reading the file.
    if (isTestLikeSource(relativePath, '')) {
        return true;
    }
    const text = await readCandidateText(file);
    return text !== undefined && isTestLikeSource(relativePath, text);
}

async function loadCandidates(candidateFiles: string[], cwd: string) {
    const candidates = await mapWithConcurrency(
        candidateFiles,
        READ_CONCURRENCY,
        async (candidatePath): Promise<RankedMatchCandidate | undefined> => {
            const candidateText = await readCandidateText(candidatePath);
            if (candidateText === undefined) {
                return undefined;
            }
            const candidateProfile = buildDocumentProfile(candidatePath, candidateText, cwd);
            return {
                file: path.relative(cwd, candidatePath),
                preview: candidateProfile.preview,
                profile: candidateProfile,
            };
        }
    );
    return candidates.filter((candidate) => candidate !== undefined);
}

async function matchChangedFiles(
    changes: ChangedFiles,
    candidates: RankedMatchCandidate[],
    config: RuntimeConfig,
    candidateLimitReached: boolean,
    cwd: string
) {
    const changedPaths = new Set(changes.paths);
    // Automatic mode runs what it selects, so only test-like files are candidates there. Elsewhere a
    // changed source module is still never a test to run; a changed test stays a candidate for the other files.
    const eligible = candidates.filter((candidate) => changes.automatic
        ? isTestLike(candidate.profile)
        : isTestLike(candidate.profile) || !changedPaths.has(path.resolve(cwd, candidate.file))
    );
    const changed: Array<{ source: ChangedSource; fileCandidates: RankedMatchCandidate[] }> = [];
    for (const changedPath of changes.paths) {
        changed.push({
            source: await readChangedFile(changedPath, changes, cwd),
            // Automatic mode also selects an edited test for itself, so it runs.
            fileCandidates: changes.automatic
                ? eligible
                : eligible.filter((candidate) => path.resolve(cwd, candidate.file) !== changedPath),
        });
    }

    let ranker = config.ranker;
    let rankerFallback: string | undefined;
    const jevResults: JevScoreResult[] = [];
    if (ranker === 'jev') {
        let scorer: JevScorer | undefined;
        try {
            const provider = resolveJevProvider(config.jevProvider, config.jevModel);
            scorer = new JevScorer({
                apiKey: process.env[provider.apiKeyEnv] ?? '',
                model: provider.model,
                endpoint: provider.endpoint,
                provider: provider.name,
                apiKeyEnv: provider.apiKeyEnv,
                cacheDir: config.cacheDir,
            });
            for (const { source, fileCandidates } of changed) {
                // A supplied --diff-file limits what is sent to its hunks; automatic mode may send a new file's text.
                const diffOnly = !changes.automatic && changes.diffText !== undefined;
                jevResults.push(await scorer.score({ profile: source.profile, text: source.text, diffOnly }, fileCandidates));
            }
        } catch (error) {
            if (!(error instanceof JevError)) {
                throw error;
            }
            // Keep test selection working (e.g. CI without the secret); report the downgrade.
            // The whole run falls back, so merged scores never mix Jev-blended and heuristic-only files.
            rankerFallback = error.message;
            ranker = 'heuristics';
            console.warn(`Warning: jev ranker unavailable (${error.message}); ranking with heuristics only`);
        } finally {
            await scorer?.flush();
        }
    }
    return changed.map(({ source, fileCandidates }, index) => rankChangedFile(
        source,
        fileCandidates,
        { ranker, rankerFallback, jevResult: ranker === 'jev' ? jevResults[index] : undefined },
        config,
        candidateLimitReached
    ));
}

async function readChangedFile(changedPath: string, changes: ChangedFiles, cwd: string) {
    const file = path.relative(cwd, changedPath);
    const fileText = await readFileIfExists(changedPath);
    // A deleted file has no text; its profile comes from the path and the diff.
    const text = fileText ?? '';
    const profile = buildDocumentProfile(changedPath, text, cwd, changes.diffText, changes.diffRoot);
    if (fileText === undefined && !profile.diffExcerpt) {
        throw new Error(`Changed file not found: ${file} (pass a --diff-file that deletes it)`);
    }
    return { file, text, profile };
}

function rankChangedFile(
    source: ChangedSource,
    candidates: RankedMatchCandidate[],
    { ranker, rankerFallback, jevResult }: { ranker: Ranker; rankerFallback?: string; jevResult?: JevScoreResult },
    config: RuntimeConfig,
    candidateLimitReached: boolean
) {
    const ranked = jevResult
        ? candidates.map((candidate) => ({ ...candidate, jevScore: jevResult.scores.get(candidate.file) }))
        : candidates;
    const matches = rankMatches({ profile: source.profile }, ranked);
    const filtered = filterMatches(matches, config.match.minScore);
    const selection = selectMatches(filtered, config.match.topK, config.match.selectionPolicy, ranker);
    return {
        file: source.file,
        ranker,
        rankerFallback,
        // One version names the model that answered; otherwise the requested id, with every version in jev.models.
        model: ranker === 'jev' ? (jevResult?.models.length === 1 ? jevResult.models[0] : config.jevModel) : undefined,
        matched: selection.results.length,
        candidateCount: matches.length,
        threshold: config.match.threshold,
        minScore: config.match.minScore,
        topK: config.match.topK ?? null,
        selectionLimit: selection.effectiveLimit,
        selectionPolicy: config.match.selectionPolicy,
        selectionFallback: selection.reason,
        eligibleCount: selection.eligibleCount,
        selectionTruncated: selection.truncated,
        selectionEvidence: selection.evidence,
        targetedJevThreshold: config.match.selectionPolicy === 'targeted' ? TARGETED_JEV_THRESHOLD : undefined,
        source: source.profile.preview,
        jev: jevResult && {
            requests: jevResult.requests,
            cacheHits: jevResult.cacheHits,
            inputTokens: jevResult.inputTokens,
            models: jevResult.models,
        },
        candidateLimitReached,
        results: selection.results,
    };
}

// A test selected for several changed files keeps its best score.
function mergeSelections(reports: ChangeReport[]) {
    const bestByFile = new Map<string, MatchCandidate>();
    for (const match of reports.flatMap((report) => report.results)) {
        if ((bestByFile.get(match.file)?.score ?? -1) < match.score) {
            bestByFile.set(match.file, match);
        }
    }
    const merged = [...bestByFile.values()].sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
    // All reports share one config, so the per-file limit is also the overall limit.
    const limit = reports[0]?.selectionLimit;
    return typeof limit === 'number' ? merged.slice(0, limit) : merged;
}

function printJson(reports: ChangeReport[], selected: MatchCandidate[], cacheEntries: number) {
    console.log(JSON.stringify(reports.length === 1
        ? { ...reports[0], cacheEntries }
        : {
            files: reports.map((report) => report.file),
            matched: selected.length,
            cacheEntries,
            results: selected,
            changes: reports,
        }));
}

function printText(
    reports: ChangeReport[],
    selected: MatchCandidate[],
    config: RuntimeConfig,
    candidateLimitReached: boolean
) {
    if (!config.quiet) {
        for (const report of reports) {
            console.log(`Matched ${report.matched}/${report.candidateCount} candidates for ${report.file}`);
            if (report.selectionFallback) {
                console.log(`  Why: ${report.selectionFallback}`);
            }
            if (report.selectionTruncated) {
                console.log(`  Selection capped at ${report.matched} of ${report.eligibleCount} eligible tests`);
            }
        }
        if (candidateLimitReached) {
            console.log(`Candidate scan truncated at ${MAX_CANDIDATE_FILES} files`);
        }
        if (reports.length > 1) {
            console.log(`Selected ${selected.length} tests for ${reports.length} changed files`);
        }
    }

    if (!selected.length && !config.quiet) {
        console.log(`No matches reached minimum score ${config.match.minScore}`);
    }
    for (const match of selected) {
        console.log(`${match.score.toFixed(4)} ${match.file}`);
        if (config.verbose && match.preview) {
            console.log(`  ${match.preview}`);
        }
    }
}
