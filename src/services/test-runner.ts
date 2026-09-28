// Windows runs .cmd shims such as npx.cmd only through cmd.exe; cross-spawn does that with escaped
// arguments and is plain child_process.spawn elsewhere.
import spawn from 'cross-spawn';
import fs from 'node:fs/promises';
import { constants } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { commandArguments } from '../utils/shell.ts';
import { JEV_API_KEY_ENV, OPENJEV_API_KEY_ENV } from './jev.ts';

export { quoteShellArgument } from '../utils/shell.ts';

// Test scripts that take test file paths as trailing arguments.
const RUNNER_SCRIPT = /^(?:vitest|jest|playwright test|mocha)(?:\s|$)/;
// Chained, piped, or expanded scripts would not pass file paths through intact.
const SHELL_SYNTAX = /[&|;<>$`]/;
const RUNNER_DEPENDENCIES: Array<[string, string]> = [
    ['vitest', 'npx vitest run'],
    ['jest', 'npx jest'],
    ['@playwright/test', 'npx playwright test'],
    ['mocha', 'npx mocha'],
];

// Common runner options that take their value as the next word, so that word is not a test path.
const VALUE_OPTIONS: Record<string, ReadonlySet<string>> = {
    jest: new Set([
        '-c', '--config', '--rootDir', '--roots', '--selectProjects', '--ignoreProjects', '-t', '--testNamePattern',
        '--testEnvironment', '--env', '-w', '--maxWorkers', '--maxConcurrency', '--reporters', '--shard',
        '--testTimeout', '--outputFile', '--coverageDirectory', '--coverageProvider', '--seed', '--cacheDirectory',
    ]),
    vitest: new Set([
        '-c', '--config', '-r', '--root', '--dir', '--project', '--reporter', '--outputFile', '--environment',
        '--pool', '--shard', '--mode', '-t', '--testNamePattern', '--maxWorkers', '--testTimeout', '--retry',
    ]),
    playwright: new Set([
        '-c', '--config', '--project', '--reporter', '-j', '--workers', '-g', '--grep', '--grep-invert', '--shard',
        '--timeout', '--retries', '--output', '--repeat-each', '--max-failures', '--trace', '--browser',
        '--global-timeout', '--tsconfig',
    ]),
    mocha: new Set([
        '--config', '--package', '-r', '--require', '-R', '--reporter', '-O', '--reporter-option', '-t', '--timeout',
        '-s', '--slow', '-g', '--grep', '-f', '--fgrep', '-u', '--ui', '--extension', '--ignore', '--exclude',
        '-j', '--jobs', '--retries', '-n', '--node-option',
    ]),
};
// Options whose value names test files, which would run alongside the appended selection.
const SELECTOR_OPTIONS = new Set(['--spec', '--file', '--testPathPattern', '--testPathPatterns', '--testMatch']);

/**
 * Whether a runner script already names test files, as in `jest tests`, `mocha 'tests/**'`, or
 * `mocha --spec x`; with the selected files appended, the runner would still run those too.
 * A value that follows an unknown option counts as a path, so that doubt never widens a run.
 */
function selectsTestPaths(script: string): boolean {
    let args: string[];
    try {
        args = commandArguments(script);
    } catch {
        return true;
    }
    const runnerWords = args[0] === 'playwright' || (args[0] === 'vitest' && args[1] === 'run') ? 2 : 1;
    const valueOptions = VALUE_OPTIONS[args[0]] ?? new Set<string>();
    for (let index = runnerWords; index < args.length; index += 1) {
        const [name] = args[index].split('=', 1);
        if (!args[index].startsWith('-') || SELECTOR_OPTIONS.has(name)) {
            return true;
        }
        if (!args[index].includes('=') && valueOptions.has(name)) {
            index += 1;
        }
    }
    return false;
}

/** Guesses the command that runs chosen test files, from package.json; undefined when unsure. */
export async function detectTestCommand(cwd: string): Promise<string | undefined> {
    let manifest;
    try {
        manifest = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8')) ?? {};
    } catch {
        // No readable package.json means no guess; the user can still type a command.
        return undefined;
    }
    const script = String(manifest.scripts?.test ?? '').trim();
    if (RUNNER_SCRIPT.test(script) && !SHELL_SYNTAX.test(script) && !selectsTestPaths(script)) {
        // Plain `vitest` starts watch mode; `vitest run` exits when the tests finish.
        return `npx ${script.replace(/^vitest(?!\s+run\b)/, 'vitest run')}`;
    }
    const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
    return RUNNER_DEPENDENCIES.find(([name]) => name in dependencies)?.[1];
}

export async function runSelectedTests(command: string, files: string[], cwd: string): Promise<number> {
    // Many runners interpret an empty file list as "run the entire suite".
    if (!files.length) return 0;
    const [executable, ...args] = commandArguments(command);
    const testPaths = [...new Set(files.map(file => path.resolve(cwd, file)))];
    // The Jev key is for ranking only; the project's tests never need it. Windows names are case-insensitive.
    const env = Object.fromEntries(
        Object.entries(process.env).filter(([name]) =>
            name.toUpperCase() !== JEV_API_KEY_ENV && name.toUpperCase() !== OPENJEV_API_KEY_ENV
        )
    );
    return new Promise((resolve, reject) => {
        const child = spawn(executable, [...args, ...testPaths], { cwd, env, stdio: 'inherit', shell: false });
        const interrupt = () => { child.kill('SIGINT'); };
        const terminate = () => { child.kill('SIGTERM'); };
        const cleanup = () => {
            process.off('SIGINT', interrupt);
            process.off('SIGTERM', terminate);
        };
        process.on('SIGINT', interrupt);
        process.on('SIGTERM', terminate);
        child.once('error', (error) => {
            cleanup();
            reject(error);
        });
        child.once('close', (code, signal) => {
            cleanup();
            resolve(code ?? (signal ? 128 + constants.signals[signal] : 1));
        });
    });
}

export async function promptAndRunTests(files: string[], cwd: string): Promise<number> {
    if (!files.length) return 0;
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error('Test execution needs an interactive terminal. Use --json or --paths-only for selection without running tests.');
    }
    const suggestion = await detectTestCommand(cwd);
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    const controller = new AbortController();
    prompt.on('SIGINT', () => controller.abort());
    prompt.once('close', () => controller.abort());
    let command: string;
    try {
        const answer = prompt.question(
            suggestion
                ? '\nTest command (Enter to run, clear the line to skip): '
                : '\nTest command (e.g. npx playwright test, npx vitest run, node --test; Enter to skip): ',
            { signal: controller.signal },
        );
        // Pre-fill the detected command so the user can run, edit, or clear it.
        if (suggestion) prompt.write(suggestion);
        command = await answer;
    } catch (error) {
        if (controller.signal.aborted) return 130;
        throw error;
    } finally {
        prompt.close();
    }
    if (!command.trim()) {
        console.log('Tests not run.');
        return 0;
    }
    return runSelectedTests(command, files, cwd);
}
