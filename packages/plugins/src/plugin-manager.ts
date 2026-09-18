import { TaskGraph } from '@taskforge/core';
import {
  TaskForgePlugin,
  PluginCapability,
  RunContext,
  PlanContext,
  TaskContext,
  TaskResult,
  VerificationContext,
  PluginVerificationResult,
  PluginErrorRecord,
} from './types.js';

export class PluginManager {
  private plugins: Map<string, TaskForgePlugin> = new Map();
  private errors: PluginErrorRecord[] = [];

  register(plugin: TaskForgePlugin): void {
    this.plugins.set(plugin.name, plugin);
  }

  unregister(pluginName: string): boolean {
    return this.plugins.delete(pluginName);
  }

  getPlugin(pluginName: string): TaskForgePlugin | undefined {
    return this.plugins.get(pluginName);
  }

  listPlugins(): TaskForgePlugin[] {
    return Array.from(this.plugins.values());
  }

  getAllCapabilities(): PluginCapability[] {
    const caps: PluginCapability[] = [];
    for (const plugin of this.plugins.values()) {
      caps.push(...plugin.capabilities());
    }
    return caps;
  }

  getErrors(): PluginErrorRecord[] {
    return [...this.errors];
  }

  clearErrors(): void {
    this.errors = [];
  }

  private recordError(pluginName: string, hook: string, err: unknown): void {
    const error = err instanceof Error ? err : new Error(String(err));
    this.errors.push({
      pluginName,
      hook,
      error,
      timestamp: new Date(),
    });
  }

  async dispatchRunStart(ctx: RunContext): Promise<void> {
    for (const plugin of this.plugins.values()) {
      if (plugin.onRunStart) {
        try {
          await plugin.onRunStart(ctx);
        } catch (err) {
          this.recordError(plugin.name, 'onRunStart', err);
        }
      }
    }
  }

  async dispatchBeforePlan(ctx: PlanContext): Promise<void> {
    for (const plugin of this.plugins.values()) {
      if (plugin.beforePlan) {
        try {
          await plugin.beforePlan(ctx);
        } catch (err) {
          this.recordError(plugin.name, 'beforePlan', err);
        }
      }
    }
  }

  async dispatchAfterPlan(graph: TaskGraph): Promise<void> {
    for (const plugin of this.plugins.values()) {
      if (plugin.afterPlan) {
        try {
          await plugin.afterPlan(graph);
        } catch (err) {
          this.recordError(plugin.name, 'afterPlan', err);
        }
      }
    }
  }

  async dispatchBeforeTask(ctx: TaskContext): Promise<TaskContext> {
    let currentCtx = { ...ctx };
    for (const plugin of this.plugins.values()) {
      if (plugin.beforeTask) {
        try {
          currentCtx = await plugin.beforeTask(currentCtx);
        } catch (err) {
          this.recordError(plugin.name, 'beforeTask', err);
        }
      }
    }
    return currentCtx;
  }

  async dispatchAfterTask(result: TaskResult): Promise<void> {
    for (const plugin of this.plugins.values()) {
      if (plugin.afterTask) {
        try {
          await plugin.afterTask(result);
        } catch (err) {
          this.recordError(plugin.name, 'afterTask', err);
        }
      }
    }
  }

  async dispatchVerify(ctx: VerificationContext): Promise<PluginVerificationResult[]> {
    const results: PluginVerificationResult[] = [];
    for (const plugin of this.plugins.values()) {
      if (plugin.verify) {
        try {
          const res = await plugin.verify(ctx);
          results.push(res);
        } catch (err) {
          this.recordError(plugin.name, 'verify', err);
          results.push({
            passed: false,
            gateName: `${plugin.name}-verify`,
            message: `Plugin verification error: ${(err as Error).message}`,
          });
        }
      }
    }
    return results;
  }

  async dispatchRunComplete(ctx: RunContext): Promise<void> {
    for (const plugin of this.plugins.values()) {
      if (plugin.onRunComplete) {
        try {
          await plugin.onRunComplete(ctx);
        } catch (err) {
          this.recordError(plugin.name, 'onRunComplete', err);
        }
      }
    }
  }
}
