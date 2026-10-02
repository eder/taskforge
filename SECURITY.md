# Security Policy

TaskForge orchestrates coding agents that read, write and execute code in your repositories, so security reports are taken seriously.

## Supported versions

TaskForge is pre-1.0. Security fixes are applied to the latest released version and to `main`.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Use GitHub's private vulnerability reporting:
<https://github.com/eder/taskforge/security/advisories/new>

Include, where possible:

- the affected version or commit;
- a description of the impact (what an attacker or a misbehaving agent can do);
- minimal steps to reproduce;
- any suggested fix.

This is a volunteer-maintained open-source project. Reports are acknowledged on a best-effort basis; please allow a reasonable time for triage and a fix before any public disclosure. Reporters who follow this process are credited in the release notes unless they prefer to remain anonymous.

## Security model and known limitations

This page is summarised for new users in the README's [Safety](README.md#safety-read-this-first) section, in `tf setup`, and in a notice shown once on first launch.

Be aware of what TaskForge does and does not enforce:

- **Agents run as your user.** There is no OS-level sandbox. An agent shares your `HOME`, so it can read files your user can read (for example `~/.ssh`, `~/.aws`, shell history). TaskForge limits *what it forwards* and *what it integrates*, not what the agent process can touch. For untrusted repositories or high-risk work, run TaskForge inside a container or VM.
- **Write boundaries are enforced after the fact, inside the worktree.** Read-only tasks have any mutation reverted. Writable tasks fail (and are retried or blocked) if they change files outside their `allowedScope` (`verification.enforceScope`, on by default). Writes by an agent *outside* its worktree are not prevented or detected.
- **Provider permission prompts are the provider's.** Agents run non-interactively with their provider's own permission handling. TaskForge's permission policy governs requests that reach it; it cannot veto an action a provider CLI performs on its own.
- **Credentials are forwarded per provider.** Each agent receives only its own provider's variables (for example `ANTHROPIC_API_KEY` for Claude Code, `OPENAI_API_KEY` for Codex). TaskForge's own router key (`TASKFORGE_OPENAI_API_KEY`) is never forwarded, and neither is `SSH_AUTH_SOCK` unless you opt in with `agents.<id>.passEnv`.
- **Nothing reaches your branch automatically** unless you set `delivery.mode: auto_apply` *and* `permissions.git.merge_main: allow`.

## What is in scope

TaskForge's design boundary is that model output may *propose* decisions but deterministic code controls permissions, process lifecycles, Git state and verification. Reports are especially valuable when they show that boundary being crossed, for example:

- an agent action that bypasses the permission engine (`permissions.*` policy) or the headless policy;
- writes outside an assignment's isolated worktree or outside its `allowedScope`/ownership rules;
- secrets (for example `TASKFORGE_OPENAI_API_KEY`) leaking into agent subprocess environments, logs, the database or pull requests;
- a delivery path (`/apply`, `/pr`, `auto_apply`) that merges or pushes without the configured approvals, or touches the target branch on conflict;
- path traversal or oversized-payload handling in project-instruction discovery (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`);
- command injection through goal text, branch names or configuration values.

## Out of scope

- Vulnerabilities in the third-party agent CLIs themselves (Claude Code, Codex CLI, Google Antigravity) or in model providers; report those upstream.
- Behavior that requires an attacker to already control your machine, your `~/.taskforge/config.yaml`, or your repository's `.taskforge/config.yaml` with permissive settings you chose (for example setting `permissions.commands.sudo: allow`).
- Agent output quality problems that do not cross a security boundary.

## Hardening tips for users

- Keep the defaults: `workspace_write: allow` only inside worktrees, `network`, `package_install` and `push` as `ask_human`, `force_push`, `sudo` and `merge_main` as `deny`.
- Prefer `delivery.mode: ask_human` or `pull_request`; `auto_apply` additionally requires `permissions.git.merge_main: allow` as an explicit opt-in.
- Store the OpenAI key in `TASKFORGE_OPENAI_API_KEY` or `~/.taskforge/config.yaml`, never in a repository file.
- Review `/diff` before `/apply` or `/pr`.
