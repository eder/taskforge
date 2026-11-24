import { PassThrough } from 'node:stream';
import type { TaskForgeConfig } from '@taskforge/shared';
import { TaskForgeDatabase } from '@taskforge/persistence';
import { InteractiveShell, type ShellOptions } from './interactive-shell.js';
import { loadLivingPlan, type LivingPlan } from './living-plan.js';
import { addProjectMemoryEntry, loadProjectMemory, type ProjectMemoryEntry } from './project-memory.js';
import { LocalWebCockpitServer } from './local-web-cockpit.js';

export interface TaskForgeClientOptions {
  repoRoot?: string;
  config?: TaskForgeConfig;
  database?: TaskForgeDatabase;
  smartDirectDispatch?: boolean;
}

/**
 * Programmatic TypeScript SDK (`@taskforge/conversation` / `@taskforge/sdk`)
 * allowing scripts, CI pipelines, and internal tools to drive TaskForge's
 * multi-agent pipelines, Debate Councils, Living Plans, checkpoints, and
 * durable project memory in a few lines of TypeScript.
 */
export class TaskForgeClient {
  public readonly shell: InteractiveShell;
  public readonly repoRoot: string;
  private readonly ownedDb?: TaskForgeDatabase;

  constructor(options: TaskForgeClientOptions = {}) {
    this.repoRoot = options.repoRoot ?? process.cwd();
    const shellOpts: ShellOptions = {
      repoRoot: this.repoRoot,
      config: options.config,
      database: options.database,
      output: new PassThrough(),
      interactive: false,
      smartDirectDispatch: options.smartDirectDispatch ?? true,
    };
    this.shell = new InteractiveShell(shellOpts);
  }

  /** Sends any prompt, `@agent` directive, `@a -> @b` pipeline, or `/command`. */
  public async run(input: string, abortSignal?: AbortSignal): Promise<string> {
    return this.shell.handleInput(input, abortSignal);
  }

  /** Convenes a 3-round Multi-Agent Solution Debate Council. */
  public async council(problem: string, agents?: string[]): Promise<string> {
    const prefix = agents?.length ? `${agents.map((a) => `@${a}`).join(' ')} ` : '';
    return this.shell.handleInput(`/council ${prefix}${problem}`);
  }

  /** Creates or inspects a domain-agnostic Living Plan (`.taskforge/plan.md`). */
  public async blueprint(goal?: string): Promise<{ output: string; plan?: LivingPlan }> {
    const output = await this.shell.handleInput(goal ? `/blueprint ${goal}` : '/blueprint');
    return { output, plan: loadLivingPlan(this.repoRoot) };
  }

  /** Reads or appends durable cross-agent project memory (`.taskforge/memory.md`). */
  public getMemory(): ProjectMemoryEntry[] {
    return loadProjectMemory(this.repoRoot);
  }

  public remember(fact: string, category: ProjectMemoryEntry['category'] = 'decision'): void {
    addProjectMemoryEntry(this.repoRoot, fact, category);
  }

  /** Undoes the latest Direct Mode edit checkpoint or applied run. */
  public async undo(): Promise<string> {
    return this.shell.handleInput('/undo');
  }

  /** Starts the strictly-local Web Cockpit (`127.0.0.1`) attached to this workspace. */
  public async startLocalUi(port?: number): Promise<LocalWebCockpitServer> {
    const db = (this.shell as unknown as { db: TaskForgeDatabase }).db;
    const server = new LocalWebCockpitServer({
      repoRoot: this.repoRoot,
      db,
      port,
      onAction: async (action) => {
        if (action === 'undo') {
          const msg = await this.undo();
          return { ok: true, message: msg };
        }
        return { ok: false, message: `Unknown action ${action}` };
      },
    });
    await server.start();
    return server;
  }

  public close(): void {
    this.ownedDb?.close();
  }
}
