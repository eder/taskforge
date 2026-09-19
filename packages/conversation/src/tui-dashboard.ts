import { TaskGraph } from '@taskforge/core';
import { AgentDetectionReport } from '@taskforge/agents';
import { RunSummaryStats, RunCostReport } from '@taskforge/telemetry';

export interface DashboardData {
  repoRoot: string;
  branch: string;
  headCommit: string;
  isClean: boolean;
  graph?: TaskGraph;
  agents: AgentDetectionReport[];
  runStats?: RunSummaryStats;
  costReport?: RunCostReport;
  worktrees?: Array<{ id: string; branch: string; agentId: string; status: string }>;
  events?: Array<{ timestamp: Date; message: string }>;
}

export class TuiDashboard {
  private static statusColor(status: string): string {
    const s = status.toUpperCase();
    switch (s) {
      case 'INTEGRATED':
      case 'VERIFIED':
      case 'COMPLETED':
        return `\x1b[32m[✓ ${s}]\x1b[0m`;
      case 'RUNNING':
      case 'VERIFICATION':
        return `\x1b[33m[● ${s}]\x1b[0m`;
      case 'READY':
      case 'ACCEPTED':
      case 'ASSIGNED':
        return `\x1b[36m[○ ${s}]\x1b[0m`;
      case 'FAILED':
      case 'BLOCKED':
        return `\x1b[31m[✕ ${s}]\x1b[0m`;
      default:
        return `[${s}]`;
    }
  }

  static renderTaskGraph(graph: TaskGraph): string {
    const tasks = graph.getAllTasks();
    if (tasks.length === 0) {
      return '  (No tasks registered)';
    }

    const lines: string[] = [];
    lines.push('┌── Task Graph (DAG) ────────────────────────────────────────────┐');

    for (const task of tasks) {
      const statusBadge = this.statusColor(task.status);
      const depText = task.dependencies.length > 0 ? ` ↳ depends on: [${task.dependencies.join(', ')}]` : '';
      lines.push(`│  ${task.id.padEnd(10)} ${statusBadge.padEnd(16)} ${task.title.slice(0, 32).padEnd(32)} │`);
      if (depText) {
        lines.push(`│             \x1b[90m${depText.padEnd(52)}\x1b[0m │`);
      }
    }

    lines.push('└────────────────────────────────────────────────────────────────┘');
    return lines.join('\n');
  }

  static render(data: DashboardData): string {
    const lines: string[] = [];

    // Header
    const cleanLabel = data.isClean ? '\x1b[32mclean\x1b[0m' : '\x1b[33mmodified\x1b[0m';
    lines.push('╔══════════════════════════════════════════════════════════════════╗');
    lines.push('║                      TASKFORGE CONTROL PLANE                     ║');
    lines.push('╚══════════════════════════════════════════════════════════════════╝');
    lines.push(`  Repository  : ${data.repoRoot}`);
    lines.push(`  Git Status  : ${data.branch} (${data.headCommit.slice(0, 7)}) • ${cleanLabel}`);
    lines.push('');

    // Agents
    lines.push('┌── Available Agents ────────────────────────────────────────────┐');
    const agentCols = data.agents
      .map((a) => {
        const icon = a.ready ? '\x1b[32m●\x1b[0m' : '\x1b[90m○\x1b[0m';
        return `${icon} ${a.name.padEnd(16)}`;
      })
      .join('  ');
    lines.push(`│  ${agentCols.padEnd(70)}│`);
    lines.push('└────────────────────────────────────────────────────────────────┘');
    lines.push('');

    // Task Graph
    if (data.graph) {
      lines.push(this.renderTaskGraph(data.graph));
      lines.push('');
    }

    // Worktrees
    if (data.worktrees && data.worktrees.length > 0) {
      lines.push('┌── Isolated Worktrees ──────────────────────────────────────────┐');
      for (const wt of data.worktrees) {
        lines.push(
          `│  ${wt.id.padEnd(12)} • ${wt.branch.padEnd(20)} • [${wt.agentId.padEnd(8)}] • ${wt.status.padEnd(12)}│`,
        );
      }
      lines.push('└────────────────────────────────────────────────────────────────┘');
      lines.push('');
    }

    // Telemetry & Stats bar
    if (data.runStats || data.costReport) {
      lines.push('┌── Metrics & Telemetry ─────────────────────────────────────────┐');
      if (data.runStats) {
        const dur = (data.runStats.durationMs / 1000).toFixed(1);
        const pass = (data.runStats.firstPassRate * 100).toFixed(0);
        lines.push(
          `│  Duration: ${dur}s  •  Completed: ${data.runStats.tasksCompleted}/${data.runStats.tasksCount}  •  First pass: ${pass}%  •  Rework: ${data.runStats.reworkCount} │`,
        );
      }
      if (data.costReport) {
        lines.push(
          `│  Estimated cost: $${data.costReport.totalCostUsd.toFixed(4)} USD (${data.costReport.totalInputTokens} tokens in / ${data.costReport.totalOutputTokens} out) │`,
        );
      }
      lines.push('└────────────────────────────────────────────────────────────────┘');
      lines.push('');
    }

    return lines.join('\n');
  }
}
