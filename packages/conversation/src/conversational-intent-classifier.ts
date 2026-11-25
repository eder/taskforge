import {
  DEFAULT_OPENAI_BASE_URL,
  resolveOpenAIApiKey,
  resolveOpenAIBaseUrl,
  resolveRouterModel,
  type TaskForgeConfig,
} from '@taskforge/shared';
import type { AgentRegistry } from '@taskforge/agents';
import type { DeliveryFollowUpReply, PendingOrchestratedDelivery } from './smart-delivery.js';
import type { PendingDirectGitAction } from './direct-git-actions.js';

export type IntentClassifierProvider = 'ollama' | 'openai' | 'custom';

export type DeliveryReplyDecision = DeliveryFollowUpReply | 'unrelated';
export type PlanApprovalDecision = 'approve' | 'reject' | 'revise';
export type DirectGitConfirmationDecision = 'confirm' | 'cancel' | 'custom_text';

export type ControlPlaneIntentKind =
  | 'open_pr'
  | 'commit_changes'
  | 'apply_run'
  | 'show_diff'
  | 'discard_run'
  | 'undo'
  | 'git_status'
  | 'inspect_agents'
  | 'inspect_tasks'
  | 'inspect_health'
  | 'engineering_task';

export interface ControlPlaneShellContext {
  hasReadyRun: boolean;
  hasDirtyWorkingTree: boolean;
  hasUndoCheckpoint: boolean;
  currentBranch: string;
}

export type StructuredClassifierCaller = (
  systemPrompt: string,
  userContent: string,
  schema: Record<string, unknown>,
) => Promise<unknown>;

export interface ConversationalIntentClassifierOptions {
  config: TaskForgeConfig;
  agentRegistry: AgentRegistry;
  repoRoot: string;
  timeoutMs?: number;
  /** Optional custom structured JSON caller (used by tests or SDK integrations). */
  customCaller?: StructuredClassifierCaller;
  /** Allow live HTTP calls inside Vitest (defaults to false so unit tests stay offline/deterministic). */
  enableLiveCallsInTests?: boolean;
}

const VALID_DELIVERY_REPLIES = new Set<DeliveryReplyDecision>([
  'accept',
  'pr',
  'apply',
  'diff',
  'discard',
  'unrelated',
]);

const VALID_PLAN_DECISIONS = new Set<PlanApprovalDecision>(['approve', 'reject', 'revise']);

const VALID_DIRECT_GIT_DECISIONS = new Set<DirectGitConfirmationDecision>([
  'confirm',
  'cancel',
  'custom_text',
]);

const VALID_CONTROL_PLANE_INTENTS = new Set<ControlPlaneIntentKind>([
  'open_pr',
  'commit_changes',
  'apply_run',
  'show_diff',
  'discard_run',
  'undo',
  'git_status',
  'inspect_agents',
  'inspect_tasks',
  'inspect_health',
  'engineering_task',
]);

const DELIVERY_REPLY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    reply: {
      type: 'string',
      enum: ['accept', 'pr', 'apply', 'diff', 'discard', 'unrelated'],
    },
    confidence: {
      type: 'string',
      enum: ['high', 'medium', 'low'],
    },
  },
  required: ['reply', 'confidence'],
  additionalProperties: false,
};

const PLAN_APPROVAL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    decision: {
      type: 'string',
      enum: ['approve', 'reject', 'revise'],
    },
    confidence: {
      type: 'string',
      enum: ['high', 'medium', 'low'],
    },
  },
  required: ['decision', 'confidence'],
  additionalProperties: false,
};

const DIRECT_GIT_CONFIRM_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    decision: {
      type: 'string',
      enum: ['confirm', 'cancel', 'custom_text'],
    },
    confidence: {
      type: 'string',
      enum: ['high', 'medium', 'low'],
    },
  },
  required: ['decision', 'confidence'],
  additionalProperties: false,
};

const CONTROL_PLANE_INTENT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    intent: {
      type: 'string',
      enum: [
        'open_pr',
        'commit_changes',
        'apply_run',
        'show_diff',
        'discard_run',
        'undo',
        'git_status',
        'inspect_agents',
        'inspect_tasks',
        'inspect_health',
        'engineering_task',
      ],
    },
    language: {
      type: 'string',
      enum: ['pt', 'en'],
    },
    confidence: {
      type: 'string',
      enum: ['high', 'medium', 'low'],
    },
  },
  required: ['intent', 'language', 'confidence'],
  additionalProperties: false,
};

const OLLAMA_DETECT_CACHE_TTL_MS = 30_000;

/**
 * Language-agnostic AI intent classifier for TaskForge's conversational shell.
 *
 * Provider priority (automatic failover):
 * 1. Local Ollama (`structuredQuery` with strict JSON schema — ~$0, ~300ms, offline)
 *    OR configured OpenAI API (when `router.provider === 'openai'`, OpenAI is tried first,
 *    then Ollama; otherwise Ollama is tried first, then OpenAI if an API key is configured).
 * 2. Returns `undefined` if neither AI provider is available or confidence is low,
 *    so callers fall back seamlessly to Tier 1 deterministic fast-path (0ms).
 *
 * Safety invariant: the model ONLY classifies user intent into a closed enum.
 * The deterministic control plane validates the enum and executes all git/PR/plan
 * actions under TaskForge's standard gates.
 */
export class ConversationalIntentClassifier {
  private readonly config: TaskForgeConfig;
  private readonly agentRegistry: AgentRegistry;
  private readonly repoRoot: string;
  private readonly timeoutMs: number;
  private readonly customCaller?: StructuredClassifierCaller;
  private readonly enableLiveCallsInTests: boolean;

  private ollamaDetectedCache?: { available: boolean; checkedAt: number };

  constructor(options: ConversationalIntentClassifierOptions) {
    this.config = options.config;
    this.agentRegistry = options.agentRegistry;
    this.repoRoot = options.repoRoot;
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.customCaller = options.customCaller;
    this.enableLiveCallsInTests = options.enableLiveCallsInTests ?? false;
  }

  /**
   * Classifies a natural-language reply (in ANY language) to a pending
   * orchestrated delivery prompt ("open PR, apply, diff, or discard?").
   */
  async classifyDeliveryReply(
    text: string,
    pending: PendingOrchestratedDelivery,
  ): Promise<DeliveryReplyDecision | undefined> {
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > 240) return undefined;

    const systemPrompt = [
      'You classify a user reply (in ANY language: English, Portuguese, Spanish, French, German, Japanese, etc.) to a coding tool delivery prompt.',
      `The user was just asked what to do with a completed run (${pending.runId}). The default recommended action is "${pending.recommendedAction}".`,
      'Return ONLY valid JSON matching the schema:',
      '- "accept": the user agrees to proceed with the recommended action (e.g. "go ahead", "ship it", "siga", "faz o que tem que fazer", "manda ver", "dale", "ok do it", "進めて").',
      '- "pr": the user specifically asks to open/create/push a pull request (e.g. "push this to github as a PR", "sobe isso num PR", "abre un pull request").',
      '- "apply": the user asks to apply/merge/commit the changes directly to the target branch.',
      '- "diff": the user wants to inspect the diff or see what changed first.',
      '- "discard": the user wants to cancel, skip, or keep only the branch without applying/PR.',
      '- "unrelated": the user is asking for a new coding task, question, or bug fix unrelated to delivering this run.',
      'Be conservative: if the user asks to implement/fix/change something new, return "unrelated".',
    ].join('\n');

    const raw = await this.classify(
      systemPrompt,
      JSON.stringify({
        recommendedAction: pending.recommendedAction,
        targetBranch: pending.targetBranch,
        verified: pending.verified,
        userMessage: trimmed,
      }),
      DELIVERY_REPLY_SCHEMA,
    );
    if (!raw || typeof raw !== 'object') return undefined;
    const obj = raw as { reply?: unknown; confidence?: unknown };
    if (obj.confidence === 'low') return undefined;
    if (typeof obj.reply === 'string' && VALID_DELIVERY_REPLIES.has(obj.reply as DeliveryReplyDecision)) {
      return obj.reply as DeliveryReplyDecision;
    }
    return undefined;
  }

  /**
   * Classifies a natural-language reply (in ANY language) when a plan or
   * focused-run action is awaiting approval.
   */
  async classifyPlanApproval(text: string): Promise<PlanApprovalDecision | undefined> {
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > 240) return undefined;

    const systemPrompt = [
      'You classify a user reply (in ANY language) to a coding execution plan waiting for approval.',
      'Return ONLY valid JSON matching the schema:',
      '- "approve": the user approves/confirms starting execution as planned (e.g. "looks great, go for it", "siga", "faz o que tem que fazer", "dale", "manda bala", "ship it", "yes proceed").',
      '- "reject": the user cancels, aborts, or rejects the plan without asking for modifications (e.g. "cancel", "forget it", "esquece", "não faz isso", "abort").',
      '- "revise": the user wants to modify, split, add, remove, or give constraints/feedback on the plan (e.g. "split task 2", "don\'t touch docs", "also add unit tests").',
      'If the user adds any new requirement, scope restriction, or modification instruction, ALWAYS return "revise".',
    ].join('\n');

    const raw = await this.classify(
      systemPrompt,
      JSON.stringify({ userMessage: trimmed }),
      PLAN_APPROVAL_SCHEMA,
    );
    if (!raw || typeof raw !== 'object') return undefined;
    const obj = raw as { decision?: unknown; confidence?: unknown };
    if (obj.confidence === 'low') return undefined;
    if (typeof obj.decision === 'string' && VALID_PLAN_DECISIONS.has(obj.decision as PlanApprovalDecision)) {
      return obj.decision as PlanApprovalDecision;
    }
    return undefined;
  }

  /**
   * Classifies a natural-language reply (in ANY language) to a direct git
   * commit or PR confirmation panel.
   */
  async classifyDirectGitConfirmation(
    text: string,
    pending: PendingDirectGitAction,
  ): Promise<DirectGitConfirmationDecision | undefined> {
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > 240) return undefined;

    const systemPrompt = [
      'You classify a user reply (in ANY language) to a Git confirmation prompt.',
      `The prompt is waiting to confirm a ${pending.kind === 'pr' ? 'Pull Request creation' : 'Git commit'}. The user can either confirm, cancel, or type a custom ${pending.kind === 'pr' ? 'PR title' : 'commit message'}.`,
      'Return ONLY valid JSON matching the schema:',
      '- "confirm": the user approves proceeding with the proposed title/message (e.g. "go ahead", "manda ver", "pode subir", "siga", "dale", "ship it", "looks good").',
      '- "cancel": the user cancels/aborts the git action (e.g. "never mind", "esquece", "cancela", "stop", "mejor no").',
      '- "custom_text": the user typed a replacement commit message or PR title (e.g. "fix: handle null token", "Update README installation steps").',
    ].join('\n');

    const raw = await this.classify(
      systemPrompt,
      JSON.stringify({
        pendingAction: pending.kind,
        proposedText: pending.kind === 'pr' ? pending.title : pending.message,
        userMessage: trimmed,
      }),
      DIRECT_GIT_CONFIRM_SCHEMA,
    );
    if (!raw || typeof raw !== 'object') return undefined;
    const obj = raw as { decision?: unknown; confidence?: unknown };
    if (obj.confidence === 'low') return undefined;
    if (
      typeof obj.decision === 'string' &&
      VALID_DIRECT_GIT_DECISIONS.has(obj.decision as DirectGitConfirmationDecision)
    ) {
      return obj.decision as DirectGitConfirmationDecision;
    }
    return undefined;
  }

  /**
   * Classifies a concise free-form message (in ANY language) when no modal
   * prompt is active, distinguishing control-plane Git/inspection commands
   * from actual software engineering tasks/questions.
   */
  async classifyControlPlaneIntent(
    text: string,
    shellContext: ControlPlaneShellContext,
  ): Promise<{ intent: ControlPlaneIntentKind; language: 'pt' | 'en' } | undefined> {
    const trimmed = text.trim();
    // Long or multi-line messages are engineering specifications, not short control-plane commands.
    if (!trimmed || trimmed.length > 220 || trimmed.includes('\n')) return undefined;

    const systemPrompt = [
      'You classify a user message (in ANY language) in a multi-agent coding CLI (TaskForge).',
      'Decide whether the user is issuing a pure Git/control-plane action OR a software engineering request (coding, bug fix, refactoring, docs, code explanation, analysis).',
      'Return ONLY valid JSON matching the schema:',
      '- "open_pr": ONLY asks to publish/push existing work and open a Pull Request (no new code edits requested).',
      '- "commit_changes": ONLY asks to commit existing changes (no new code edits requested).',
      '- "apply_run": ONLY asks to apply/merge a ready completed run onto the current branch.',
      '- "show_diff": asks to view the current git diff or see what files changed.',
      '- "discard_run": asks to discard a ready completed run.',
      '- "undo": asks to undo/revert the last edit or applied run.',
      '- "git_status": asks for git status or repository cleanliness.',
      '- "inspect_agents": asks which coding agents are available/ready/online.',
      '- "inspect_tasks": asks to see current/running tasks.',
      '- "inspect_health": asks about system/router/agent health status.',
      '- "engineering_task": ANY request that asks to write/edit/fix/refactor/test/review/explain/analyze code, OR combines coding + PR/commit in one request.',
      'CRITICAL: If the user asks to both change code AND open a PR (e.g. "fix the bug and open a PR"), return "engineering_task". When in doubt, return "engineering_task".',
      'Set "language" to "pt" if the message is in Portuguese, otherwise "en".',
    ].join('\n');

    const raw = await this.classify(
      systemPrompt,
      JSON.stringify({
        context: shellContext,
        userMessage: trimmed,
      }),
      CONTROL_PLANE_INTENT_SCHEMA,
    );
    if (!raw || typeof raw !== 'object') return undefined;
    const obj = raw as { intent?: unknown; language?: unknown; confidence?: unknown };
    if (obj.confidence === 'low') return undefined;
    if (
      typeof obj.intent === 'string' &&
      VALID_CONTROL_PLANE_INTENTS.has(obj.intent as ControlPlaneIntentKind)
    ) {
      return {
        intent: obj.intent as ControlPlaneIntentKind,
        language: obj.language === 'pt' ? 'pt' : 'en',
      };
    }
    return undefined;
  }

  private async classify(
    systemPrompt: string,
    userContent: string,
    schema: Record<string, unknown>,
  ): Promise<unknown> {
    if (this.customCaller) {
      try {
        return await this.customCaller(systemPrompt, userContent, schema);
      } catch {
        return undefined;
      }
    }

    if (process.env.VITEST && !this.enableLiveCallsInTests) {
      return undefined;
    }

    const providers: Array<'ollama' | 'openai'> =
      this.config.router.provider === 'openai' ? ['openai', 'ollama'] : ['ollama', 'openai'];

    for (const provider of providers) {
      if (provider === 'ollama') {
        const result = await this.tryOllama(systemPrompt, userContent, schema);
        if (result !== undefined) return result;
      } else {
        const result = await this.tryOpenAI(systemPrompt, userContent, schema);
        if (result !== undefined) return result;
      }
    }

    return undefined;
  }

  private async isOllamaAvailable(): Promise<boolean> {
    const ollama = this.agentRegistry.get('ollama');
    if (!ollama || typeof ollama.structuredQuery !== 'function') return false;

    const now = Date.now();
    if (
      this.ollamaDetectedCache &&
      now - this.ollamaDetectedCache.checkedAt < OLLAMA_DETECT_CACHE_TTL_MS
    ) {
      return this.ollamaDetectedCache.available;
    }

    const available = await ollama.detect().catch(() => false);
    this.ollamaDetectedCache = { available, checkedAt: now };
    return available;
  }

  private async tryOllama(
    systemPrompt: string,
    userContent: string,
    schema: Record<string, unknown>,
  ): Promise<unknown> {
    const ollama = this.agentRegistry.get('ollama');
    if (!ollama || typeof ollama.structuredQuery !== 'function') return undefined;
    if (!(await this.isOllamaAvailable())) return undefined;

    try {
      const res = await ollama.structuredQuery({
        prompt: `${systemPrompt}\n\nInput:\n${userContent}`,
        schema,
        cwd: this.repoRoot,
        timeoutMs: this.timeoutMs,
      });
      return res.value;
    } catch {
      return undefined;
    }
  }

  private async tryOpenAI(
    systemPrompt: string,
    userContent: string,
    schema: Record<string, unknown>,
  ): Promise<unknown> {
    const apiKey = resolveOpenAIApiKey(this.config);
    if (!apiKey) return undefined;

    const baseUrl =
      this.config.router.provider === 'ollama'
        ? DEFAULT_OPENAI_BASE_URL
        : resolveOpenAIBaseUrl(this.config);
    const model =
      this.config.router.provider === 'openai'
        ? resolveRouterModel(this.config)
        : process.env.PLANNER_MODEL || 'gpt-4o-mini';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'conversational_intent',
              strict: true,
              schema,
            },
          },
        }),
        signal: controller.signal,
      });
      if (!response.ok) return undefined;
      const json = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = json.choices?.[0]?.message?.content?.trim();
      if (!content) return undefined;
      return JSON.parse(content) as unknown;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }
}
