import { ProcessRunner } from '@taskforge/execution';
import type { TaskForgeConfig } from '@taskforge/shared';

export type LifecycleHookEvent = 'afterDirectEdit' | 'onRunComplete' | 'onAttentionRequired';

export interface HookExecutionResult {
  ran: boolean;
  command?: string;
  exitCode?: number;
  output?: string;
}

/**
 * Executes deterministic project lifecycle hooks configured in `.taskforge/config.yaml`
 * (`hooks.afterDirectEdit`, `hooks.onRunComplete`, `hooks.onAttentionRequired`) and
 * sends optional native desktop notifications (macOS / Linux) when enabled.
 */
export class LifecycleHookRunner {
  constructor(
    private readonly repoRoot: string,
    private readonly getConfig: () => TaskForgeConfig,
  ) {}

  public async runHook(
    event: LifecycleHookEvent,
    envExtra: Record<string, string> = {},
  ): Promise<HookExecutionResult> {
    const hooks = this.getConfig().hooks;
    const command = hooks?.[event]?.trim();
    if (!command) return { ran: false };

    const timeoutMs = Math.min((hooks?.timeoutSeconds ?? 30) * 1000, 120_000);
    try {
      const res = await ProcessRunner.run({
        command: process.env.SHELL || '/bin/sh',
        args: ['-lc', command],
        cwd: this.repoRoot,
        env: {
          ...process.env,
          TASKFORGE_HOOK_EVENT: event,
          ...envExtra,
        },
        timeoutMs,
      });
      const output = [res.stdout, res.stderr].filter((s) => s.trim()).join('\n').trim();
      return {
        ran: true,
        command,
        exitCode: res.exitCode,
        output: output.slice(0, 600),
      };
    } catch (err) {
      return {
        ran: true,
        command,
        exitCode: 1,
        output: err instanceof Error ? err.message : String(err),
      };
    }
  }

  public async notifyDesktop(title: string, message: string): Promise<boolean> {
    const cfg = this.getConfig().notifications;
    if (!cfg?.enabled || process.env.VITEST) return false;

    const safeTitle = title.replace(/["\\]/g, '').slice(0, 80);
    const safeMsg = message.replace(/["\\]/g, '').slice(0, 180);

    try {
      if (process.platform === 'darwin') {
        const soundPart = cfg.sound ? ' sound name "Glass"' : '';
        const script = `display notification "${safeMsg}" with title "${safeTitle}"${soundPart}`;
        const res = await ProcessRunner.run({
          command: 'osascript',
          args: ['-e', script],
          timeoutMs: 3000,
        });
        return res.exitCode === 0;
      }
      if (process.platform === 'linux') {
        const res = await ProcessRunner.run({
          command: 'notify-send',
          args: [safeTitle, safeMsg],
          timeoutMs: 3000,
        });
        return res.exitCode === 0;
      }
    } catch {
      // Desktop notifications are strictly best-effort.
    }
    return false;
  }
}
