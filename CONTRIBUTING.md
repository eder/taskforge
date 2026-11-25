# Contributing to TaskForge

Thanks for helping! Issues and pull requests are welcome. Participation in this project is governed by our [Code of Conduct](CODE_OF_CONDUCT.md).

## Design boundary (read this first)

> AI interprets, proposes, negotiates and reasons. Deterministic software controls authoritative state, process lifecycles, permissions, concurrency, Git state, verification and repository integrity.

Changes to the control plane must keep that boundary intact. Model output may *propose*; it must never be the authority for permissions, Git operations, verification results or task state.

## Setup

Requirements: Node.js 22+, Git, pnpm 12+ (`corepack enable`).

```bash
git clone https://github.com/eder/taskforge.git
cd taskforge
corepack enable
pnpm install
pnpm build

# Optional: link the `tf` CLI globally while developing (do not use `npm link`)
pnpm --dir apps/cli link --global
# Or run directly without linking:
pnpm tf -- --version
```

Run the same checks as CI before opening a PR:

```bash
pnpm typecheck
pnpm lint
pnpm test
```

Tests are hermetic: `tests/setup/hermetic.ts` hides installed agent CLIs and API keys and uses a throwaway `HOME`, so results do not depend on your machine. Opt-in suites that need real agents run only with `TASKFORGE_TEST_REAL_AGENTS=1` (or `TASKFORGE_TEST_CLAUDE=1`, `TASKFORGE_TEST_CODEX=1`, `TASKFORGE_TEST_AGY=1`). See `docs/pilot.md` for validating with real agents.

## Repository layout

- `apps/cli` — the `tf` CLI entry point (`bin.ts`, `cli.ts`, `setup.ts`, `selftest.ts`).
- `packages/conversation` — interactive REPL, Direct Mode & Smart Auto-Dispatch, pipelines, Debate Council (`/council`), Living Plan (`/blueprint`), Project Memory (`/memory`), Skills (`/skills`), GitHub Autopilot, Local Web Cockpit (`tf ui`), MCP Server (`tf mcp serve`), Local Daemon/Scheduler (`tf daemon`, `tf schedule`), TypeScript SDK (`TaskForgeClient`), Voice (`/voice`), and Multi-Repo (`/multirepo`).
- `packages/agents` — coding-agent adapters (`claude`, `codex`, `agy`, `ollama`, and opt-in extended adapters).
- `packages/workspace` — Git service, isolated worktree manager, per-worktree port allocator (`WorktreePortAllocator`), and offline SQLite BM25 indexer (`RepositoryIndexer`).
- `packages/collaboration` — multi-agent team execution, hybrid file mix, and `PeerMailbox` + advisory file locks.
- `packages/*` — control-plane packages (`planner`, `router`, `scheduler`, `negotiation`, `verification`, `integration`, `git-workflow`, `persistence`, `telemetry`, `shared`, `core`, `execution`, `operator`, `plugins`). Each has its own `src/` and `tests/`.
- `tests/` — end-to-end and scenario-matrix suites.
- `docs/` — user guides (`usage.md`, `direct-mode-and-workflows.md`, `living-plan-and-waves.md`, `platform-integrations.md`) and architecture specifications.

## Pull requests

- Keep PRs focused; one logical change per PR. Always target `main` directly (avoid stacked feature PRs).
- Add or update tests with the change. Bug fixes should include a regression test.
- Use [Conventional Commits](https://www.conventionalcommits.org/) in the style already used in the history (`feat(scheduler): ...`, `fix(router): ...`, `test(...)`, `docs(...)`).
- When adding a public slash command, update the command table in `README.md`; CI verifies the catalog stays documented (`slash-menu.test.ts`).
- When adding configuration, CLI subcommands, or platform surfaces, update the relevant guide in `docs/` (`docs/usage.md`, `docs/direct-mode-and-workflows.md`, `docs/living-plan-and-waves.md`, `docs/platform-integrations.md`) and `SECURITY.md` if new trust boundaries are introduced.
- Add an entry under **Unreleased** in `CHANGELOG.md` for user-visible changes.
- Keep CI green on Node.js 22 and 24.

## Reporting bugs and security issues

Use the issue templates for bugs and feature requests. For vulnerabilities, follow [`SECURITY.md`](SECURITY.md) instead of opening a public issue.

## Releasing (maintainers)

All packages share one version.

```bash
node scripts/set-version.mjs 1.0.0     # or: pnpm version:set 1.0.0
# update CHANGELOG.md (move "Unreleased" under the new version)
pnpm release:verify                     # versions, license, files, workspace deps
git commit -am "chore(release): v1.0.0"
# merge to main, then:
git tag v1.0.0 && git push origin v1.0.0
```

Pushing the tag runs `.github/workflows/release.yml`: it verifies the tag matches the package version, runs build, typecheck, lint and tests, packs every package, publishes to npm with provenance, and creates the GitHub Release. Running the workflow manually performs a dry run only.

One-time setup: the `@taskforge` npm scope must be owned by the publishing account/organization, and an automation token must be stored as the `NPM_TOKEN` repository secret.
