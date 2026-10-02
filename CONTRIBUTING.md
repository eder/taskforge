# Contributing to TaskForge

Thanks for helping! Issues and pull requests are welcome.

## Design boundary (read this first)

> AI interprets, proposes, negotiates and reasons. Deterministic software controls authoritative state, process lifecycles, permissions, concurrency, Git state, verification and repository integrity.

Changes to the control plane must keep that boundary intact. Model output may *propose*; it must never be the authority for permissions, Git operations, verification results or task state.

## Setup

Requirements: Node.js 22+, Git, pnpm.

```bash
git clone https://github.com/eder/taskforge.git
cd taskforge
pnpm install
pnpm build
```

Run the same checks as CI before opening a PR:

```bash
pnpm typecheck
pnpm lint
pnpm test
```

Tests are hermetic: `tests/setup/hermetic.ts` hides installed agent CLIs and API keys and uses a throwaway `HOME`, so results do not depend on your machine. Opt-in suites that need real agents run only with `TASKFORGE_TEST_REAL_AGENTS=1` (or `TASKFORGE_TEST_CLAUDE=1`, `TASKFORGE_TEST_CODEX=1`, `TASKFORGE_TEST_AGY=1`). See `docs/pilot.md` for validating with real agents.

## Repository layout

- `apps/cli` — the `tf` command.
- `packages/*` — control-plane packages (`planner`, `router`, `scheduler`, `agents`, `workspace`, `integration`, `git-workflow`, `persistence`, ...). Each has its own `src/` and `tests/`.
- `tests/` — end-to-end suites.
- `docs/` — architecture and usage documentation.

See [`docs/usage.md`](docs/usage.md) and the architecture documents in `docs/` for details.

## Pull requests

- Keep PRs focused; one logical change per PR.
- Add or update tests with the change. Bug fixes should include a regression test.
- Use [Conventional Commits](https://www.conventionalcommits.org/) in the style already used in the history (`feat(scheduler): ...`, `fix(router): ...`, `test(...)`, `docs(...)`).
- When adding a public slash command, update the command table in `README.md`; CI verifies the catalog stays documented.
- When adding configuration, update `.taskforge/config.yaml` comments and the configuration section in `docs/usage.md`.
- Add an entry under **Unreleased** in `CHANGELOG.md` for user-visible changes.
- Keep CI green on Node.js 22 and 24.

## Reporting bugs and security issues

Use the issue templates for bugs and feature requests. For vulnerabilities, follow [`SECURITY.md`](SECURITY.md) instead of opening a public issue.

## Releasing (maintainers)

All packages share one version.

```bash
node scripts/set-version.mjs 0.2.0     # or: pnpm version:set 0.2.0
# update CHANGELOG.md (move "Unreleased" under the new version)
pnpm release:verify                     # versions, license, files, workspace deps
git commit -am "chore(release): v0.2.0"
# merge to main, then:
git tag v0.2.0 && git push origin v0.2.0
```

Pushing the tag runs `.github/workflows/release.yml`: it verifies the tag matches the package version, runs build, typecheck, lint and tests, packs every package, publishes to npm with provenance, and creates the GitHub Release. Running the workflow manually performs a dry run only.

One-time setup: the `@taskforge` npm scope must be owned by the publishing account/organization, and an automation token must be stored as the `NPM_TOKEN` repository secret.
