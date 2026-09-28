# OpenJEV Support

This fork of [semantic-test-matcher](https://github.com/JustasMonkev/semantic-test-matcher) adds optional support for [OpenJEV](https://openjev.sh), a free community gateway to the same Jev model built by [TypeSafe](https://typesafe.ai). TypeSafe remains the default; anyone with a `TYPESAFE_API_KEY` sees zero behaviour change.

## What was added

- **`src/services/jev.ts`** — OpenJEV constants (`OPENJEV_ENDPOINT`, `OPENJEV_API_KEY_ENV`, `OPENJEV_MODEL`), `JevProviderName` type, `JevProviderConfig` interface, and `resolveJevProvider()` function. `JevScorer` now accepts optional `provider`, `endpoint`, and `apiKeyEnv` options (defaulting to TypeSafe) and uses them for the fetch URL, cache keys, and error messages.
- **`src/config.ts`** — `jevProvider` field in `AppConfig`, `RuntimeConfig`, and `MatchCommandOptions`. Resolved from `--jev-provider` flag, `JEV_PROVIDER` env var, or config file (default: `auto`).
- **`src/commands/match.ts`** — Calls `resolveJevProvider()` before constructing `JevScorer`; passes the resolved provider's endpoint, model, key env, and name. Added `--jev-provider` CLI option.
- **`src/commands/benchmark.ts`** — Same provider resolution as `match`. Added `--jev-provider` CLI option.
- **`src/commands/status.ts`** — Shows the resolved provider, endpoint, model, and both key statuses (`TYPESAFE_API_KEY` and `OPENJEV_API_KEY`).
- **`src/services/test-runner.ts`** — Also strips `OPENJEV_API_KEY` from the child test environment (it is for ranking only, like `TYPESAFE_API_KEY`).
- **`README.md`** — OpenJEV note after the intro, updated requirements, install, configuration, and "How Jev is used" sections.

## Provider selection rule

1. **Explicit choice wins**: `JEV_PROVIDER=openjev` (or `--jev-provider openjev`, or `"jevProvider": "openjev"` in config).
2. **Otherwise, if `TYPESAFE_API_KEY` is set** → TypeSafe, exactly as before (default unchanged).
3. **Otherwise, if only `OPENJEV_API_KEY` is set** → OpenJEV.
4. **Default** → TypeSafe (so error messages reference `TYPESAFE_API_KEY` as before).

| | TypeSafe (default) | OpenJEV |
|---|---|---|
| Endpoint | `https://api.typesafe.ai/v1/systemone` | `https://api.openjev.sh/v1/systemone` |
| Model | `jev-1.13.0` (pinned default) | `openjev` |
| Key env | `TYPESAFE_API_KEY` | `OPENJEV_API_KEY` |
| Retryable statuses | 408, 429, 5xx (incl. 503) | same |

## How to configure

```bash
# Use OpenJEV exclusively:
export OPENJEV_API_KEY=...

# Or force OpenJEV even when both keys are set:
export JEV_PROVIDER=openjev

# Or via CLI flag:
rbt match src/file.ts --candidates tests --jev-provider openjev

# Or in config (.rbt/config.json):
{ "jevProvider": "openjev" }
```

## How it was verified

- A live `POST https://api.openjev.sh/v1/systemone` request with model `openjev`, state `ping`, and one `noul` question returned HTTP 200.
- `grep` confirmed no hardcoded `api.typesafe.ai` default remains in any source file that was changed (the TypeSafe endpoint constant is retained for the default provider path).

## Upstream

Original project: https://github.com/JustasMonkev/semantic-test-matcher by @JustasMonkev
