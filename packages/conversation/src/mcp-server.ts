import * as readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { TASKFORGE_VERSION } from '@taskforge/shared';
import { loadLivingPlan } from './living-plan.js';
import {
  addProjectMemoryEntry,
  formatProjectMemoryDisplay,
  loadProjectMemory,
} from './project-memory.js';

export interface McpJsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpJsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface TaskForgeMcpHandlers {
  repoRoot: string;
  executeShellCommand: (command: string) => Promise<string>;
}

const MCP_TOOLS = [
  {
    name: 'taskforge_status',
    description: 'Inspect TaskForge repository status, active runs, agents, and Living Plan progress.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'taskforge_memory',
    description: 'Read or add durable cross-agent project memory entries in .taskforge/memory.md.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'add'] },
        text: { type: 'string', description: 'Fact or convention to store when action is "add".' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'taskforge_blueprint',
    description: 'Create or inspect a domain-agnostic Living Plan (.taskforge/plan.md) with phased execution waves.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'Optional project goal to generate a new blueprint.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'taskforge_council',
    description: 'Convene a 3-round Multi-Agent Solution Debate Council across ready coding agents.',
    inputSchema: {
      type: 'object',
      properties: {
        problem: { type: 'string', description: 'Architectural or engineering problem to debate.' },
      },
      required: ['problem'],
      additionalProperties: false,
    },
  },
  {
    name: 'taskforge_run_direct',
    description: 'Execute a direct agent prompt or pipeline (e.g. "@codex ...", "@codex -> @agy ...").',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Direct prompt or @agent pipeline command.' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'taskforge_checkpoints',
    description: 'List or undo automatic Direct Mode working-tree checkpoints.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'undo'] },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
];

const MCP_RESOURCES = [
  {
    uri: 'taskforge://plan',
    name: 'TaskForge Living Plan',
    mimeType: 'application/json',
    description: 'Active .taskforge/plan.md blueprint and wave statuses.',
  },
  {
    uri: 'taskforge://memory',
    name: 'TaskForge Project Memory',
    mimeType: 'application/json',
    description: 'Durable project decisions and conventions (.taskforge/memory.md).',
  },
];

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

/**
 * Zero-dependency Model Context Protocol (MCP) JSON-RPC 2.0 server over stdio
 * (`tf mcp serve`), letting external IDEs (Cursor, VS Code, Zed, Antigravity IDE,
 * Claude Desktop) invoke TaskForge's Council, Living Plan, Memory, and Direct Pipelines.
 */
export class TaskForgeMcpServer {
  constructor(private readonly handlers: TaskForgeMcpHandlers) {}

  public async handleRequest(req: McpJsonRpcRequest): Promise<McpJsonRpcResponse | undefined> {
    const id = req.id ?? null;

    if (req.method === 'notifications/initialized' || req.method === 'initialized') {
      return undefined;
    }

    if (req.method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: 'taskforge-mcp', version: TASKFORGE_VERSION },
        },
      };
    }

    if (req.method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } };
    }

    if (req.method === 'resources/list') {
      return { jsonrpc: '2.0', id, result: { resources: MCP_RESOURCES } };
    }

    if (req.method === 'resources/read') {
      const uri = String(req.params?.uri ?? '');
      if (uri === 'taskforge://plan') {
        const plan = loadLivingPlan(this.handlers.repoRoot) ?? null;
        return {
          jsonrpc: '2.0',
          id,
          result: {
            contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(plan, null, 2) }],
          },
        };
      }
      if (uri === 'taskforge://memory') {
        const mem = loadProjectMemory(this.handlers.repoRoot);
        return {
          jsonrpc: '2.0',
          id,
          result: {
            contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(mem, null, 2) }],
          },
        };
      }
      return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown resource URI: ${uri}` } };
    }

    if (req.method === 'tools/call') {
      const name = String(req.params?.name ?? '');
      const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        const text = await this.invokeTool(name, args);
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: stripAnsi(text) }] },
        };
      } catch (err) {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            isError: true,
            content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
          },
        };
      }
    }

    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${req.method}` },
    };
  }

  private async invokeTool(name: string, args: Record<string, unknown>): Promise<string> {
    switch (name) {
      case 'taskforge_status':
        return this.handlers.executeShellCommand('/health');
      case 'taskforge_memory': {
        if (args.action === 'add' && typeof args.text === 'string' && args.text.trim()) {
          const saved = addProjectMemoryEntry(this.handlers.repoRoot, args.text.trim(), 'decision');
          return `Saved memory #${saved.entry.id}: ${saved.entry.text}`;
        }
        return formatProjectMemoryDisplay(this.handlers.repoRoot);
      }
      case 'taskforge_blueprint': {
        const goal = typeof args.goal === 'string' ? args.goal.trim() : '';
        return this.handlers.executeShellCommand(goal ? `/blueprint ${goal}` : '/blueprint');
      }
      case 'taskforge_council': {
        const problem = typeof args.problem === 'string' ? args.problem.trim() : '';
        if (!problem) throw new Error('Missing required "problem" argument.');
        return this.handlers.executeShellCommand(`/council ${problem}`);
      }
      case 'taskforge_run_direct': {
        const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
        if (!prompt) throw new Error('Missing required "prompt" argument.');
        return this.handlers.executeShellCommand(prompt);
      }
      case 'taskforge_checkpoints': {
        return this.handlers.executeShellCommand(args.action === 'undo' ? '/undo' : '/checkpoints');
      }
      default:
        throw new Error(`Unknown MCP tool: ${name}`);
    }
  }

  /** Serves newline-delimited JSON-RPC over stdio (`process.stdin` / `process.stdout`). */
  public serveStdio(input: Readable = process.stdin, output: Writable = process.stdout): Promise<void> {
    return new Promise((resolve) => {
      const rl = readline.createInterface({ input, crlfDelay: Infinity });
      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        void (async () => {
          try {
            const parsed = JSON.parse(trimmed) as McpJsonRpcRequest;
            const resp = await this.handleRequest(parsed);
            if (resp) output.write(`${JSON.stringify(resp)}\n`);
          } catch {
            output.write(
              `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`,
            );
          }
        })();
      });
      rl.on('close', () => resolve());
    });
  }
}
