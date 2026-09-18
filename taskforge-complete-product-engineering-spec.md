<!-- Generated from the verified DOCX specification. -->

TASKFORGE

# Complete Product & Engineering
Specification + Roadmap

Conversational control plane for self-organizing coding-agent teams

```text
$ tf

> corrige a duplicação de cobrança sem mudar o contrato da API

TaskForge entende, planeja, forma o time, faz os agentes negociarem a task,
executa em worktrees isoladas, verifica, revisa e integra o resultado.
```

Working name: TaskForge  •  Directory: taskforge  •  Primary CLI: tf  •  September 2026

## 1. Executive Summary

TaskForge is an independent developer-tool product that coordinates existing coding-agent harnesses instead of replacing them. Its primary interface is an interactive conversational CLI. The user launches `tf`, describes an engineering objective in natural language, and continues talking to the system while a deterministic control plane plans, staffs, executes, verifies and integrates work across multiple coding agents.

The first workers are Claude Code, Codex and Gemini CLI. A task may be handled by one agent or by a temporary team. Workers may question a task before execution, ask each other for clarification, challenge the proposed decomposition, request another agent, recommend splitting or merging work, and escalate from single-agent execution to collaboration when technical reality warrants it.

A dedicated Router Agent, initially backed by the OpenAI Responses API with strict structured output, decides the minimum sufficient execution strategy for each task: one worker, pair, parallel investigation, independent review, competitive solutions or a larger collaborative team. The Router proposes team shape and roles; deterministic scheduling code owns the actual state, availability checks, permissions and execution.

ECC is an optional plugin. It can contribute task-relevant skills, rules, memory, security scans and quality gates, but TaskForge must function without ECC and must never delegate core orchestration state to it.

> **The architectural invariant is: AI interprets, proposes, negotiates and reasons; deterministic software controls authoritative state, Git, permissions, process lifecycle, verification and integration.**

### 1.1 Product north star

```text
$ tf

TaskForge
~/code/payments-api  •  main  •  clean
Claude ● ready   Codex ● ready   Gemini ● ready
ECC ● detected

> às vezes o checkout cobra duas vezes. investiga antes de mexer no código

Entendi. É uma tarefa com alta incerteza e risco financeiro.
Vou formar um time de investigação primeiro.

Claude  ● consistency analysis
Codex   ● reproduce + failing test
Gemini  ● payment/idempotency flow trace

Nenhuma escrita será permitida nesta fase.

> me avisa se eles discordarem sobre a causa

Pode deixar. Vou interromper a implementação se a causa raiz não estiver consistente.
```

### 1.2 Product promise

The user describes what they want built or investigated. TaskForge determines how a temporary team of coding agents should organize to do the work, while keeping execution observable, bounded and reviewable by a human.

## 2. Decisions Frozen for the First Product Version

| Decision | Choice |
| --- | --- |
| Working product name | TaskForge |
| Repository / directory | taskforge |
| Primary executable | tf |
| Long executable alias | taskforge |
| Primary UX | Interactive natural-language terminal session |
| Automation UX | Headless `tf exec` and structured API later |
| Core language | TypeScript on Node.js 22+ |
| State | SQLite + Git |
| Workspace isolation | Git worktrees |
| Initial workers | Claude Code, Codex, Gemini CLI |
| Initial intelligent router | OpenAI Responses API with strict structured output |
| Router failure fallback | Deterministic static routing strategy |
| ECC | Optional plugin, not a core dependency |
| Parallel writable work | Separate worktree per assignment |
| Merge to main | Never automatic in early releases |
| Default human gate | Show plan/team for approval before risky execution |

### 2.1 Naming conventions used in the codebase

```text
Project          TaskForge
Repository       taskforge
CLI              tf
CLI alias        taskforge
Project config   .taskforge/config.yaml
State database   .taskforge/taskforge.db
Worktrees        .taskforge/worktrees/
Artifacts        .taskforge/runs/<run-id>/
Integration ref  taskforge/run-<run-id>
```

## 3. Product Definition and Positioning

TaskForge is a lightweight control plane for heterogeneous coding-agent teams. It is not a new coding model. It coordinates agent harnesses that already know how to explore repositories, edit code, run commands and reason about software.

A useful analogy is Kubernetes for engineering tasks, but the analogy has limits: TaskForge schedules cognitive/engineering work rather than containers.

| Control-plane concern | TaskForge responsibility |
| --- | --- |
| What work exists | Goal interpretation, planning, task graph |
| Who should do it | Router roles + agent selection |
| How many workers | Execution strategy / team shape |
| Where it runs | Isolated worktrees and processes |
| When it runs | Dependency-aware scheduler |
| How workers coordinate | Negotiation layer + communication bus |
| Whether it is correct | Deterministic verification + independent review |
| What happens on failure | Retry, reassignment, collaboration escalation or human block |
| What is authoritative | SQLite task/run state + Git code state |
| How it learns | Telemetry and later performance-aware routing |

### 3.1 What TaskForge is not

- Not a new LLM or foundation model.
- Not an IDE or code editor.
- Not a replacement for Git.
- Not a generic agent framework for every business workflow.
- Not a wrapper that sends the same prompt to three models and votes.
- Not an ECC fork.
- Not a hosted multi-tenant SaaS in the initial product.
## 4. User Experience: Conversation First

> **Natural language is the primary interface. Commands are shortcuts, not the product.**

### 4.1 Launch experience

```text
$ tf

 TaskForge

 ~/code/my-app
 main • clean

 Agents
 Claude   ● ready
 Codex    ● ready
 Gemini   ● ready

 Router
 OpenAI   ● ready

 ECC
 ● detected

────────────────────────────────────

> _
```

### 4.2 Conversational control

```text
> implementa OAuth com Google sem quebrar login por email/senha

Vou analisar o fluxo atual antes de propor trabalho.

Gemini  ● repository analysis
Claude  ● auth architecture analysis

...

Encontrei 5 áreas envolvidas. Minha proposta é 6 tasks.
Codex pode implementar o backend enquanto Claude trabalha no frontend depois da arquitetura.
Claude fará review independente do backend.

Quer que eu execute?

> sim, mas sem dependência nova no frontend

Restrição adicionada ao run atual. Começando.
```

### 4.3 Mid-run intervention

```text
> quem está mexendo no backend?

Codex, TASK-04.
Ele está em uma worktree isolada e acabou de executar 83 testes. Dois falharam.

> coloca o Claude para revisar antes de integrar

Feito. Claude foi adicionado como reviewer obrigatório de TASK-04.
A integração ficará bloqueada até o review passar.

> não deixa ninguém escrever em legacy-payments

Restrição aplicada. legacy-payments/** agora é read-only para este run.
```

### 4.4 Slash commands

Slash commands are deterministic shortcuts for power users. Every slash command should have a natural-language equivalent.

| Shortcut | Equivalent natural language |
| --- | --- |
| /agents | “quem está disponível?” |
| /tasks | “o que está acontecendo?” |
| /task TASK-12 | “o que está acontecendo na TASK-12?” |
| /cost | “quanto já gastei?” |
| /plan | “me mostra o plano” |
| /pause | “para a execução por enquanto” |
| /resume | “continua” |
| /logs TASK-12 | “me mostra os logs da TASK-12” |

### 4.5 Headless mode

Interactive mode is the product. Headless mode exists for scripts, CI and integrations.

```text
tf exec "implement OAuth" --yes
tf exec --goal-file goal.md --json
tf inspect <run-id> --json
```

## 5. Conversational Architecture

```text
                     Human
                       │
                       ▼
                Interactive CLI
                       │
                       ▼
              Conversation Runtime
                       │
                       ▼
                 Operator Agent
                       │
                  Intent / Query
                       │
                       ▼
          Deterministic Control Plane
       ┌───────────────┼────────────────┐
       ▼               ▼                ▼
    Planner          Router          Run Query
       │               │                │
       └──────────┬────┴────────────────┘
                  ▼
               Scheduler
                  │
      Claude ↔ Codex ↔ Gemini
```

### 5.1 Operator Agent

The Operator is the conversational face of TaskForge. It translates human requests into typed control-plane intents and summarizes system state back into useful language. It must not directly mutate authoritative state.

```text
Human: "para o Codex e deixa o Claude terminar"

Operator output:
{
  "intent": "cancel_and_reassign",
  "taskId": "TASK-04",
  "fromAgent": "codex",
  "preferredReplacement": "claude"
}

Scheduler validates whether the operation is allowed, then performs it.
```

### 5.2 Conversation memory

Run conversation context should preserve user constraints, decisions and requests such as “do not add frontend dependencies” or “review security before integration.” It should not become the source of truth for task state. Durable constraints are written to structured run state.

## 6. Goal, Repository Analysis and Planning

### 6.1 Goal model

```text
interface Goal {
  id: string;
  description: string;
  repository: string;
  constraints: Constraint[];
  acceptanceCriteria: string[];
  createdAt: Date;
}
```

### 6.2 Repository Analyzer

Before planning, TaskForge builds a compact repository profile rather than pushing an entire repository into one prompt.

- Languages, frameworks and package manager.
- Build, test, lint and typecheck commands.
- Important directory topology.
- Git state and current branch.
- CI configuration.
- README, AGENTS.md, CLAUDE.md and local agent instructions.
- ECC presence and configuration.
- High-level change surface relevant to the current goal.
```text
interface RepositoryProfile {
  languages: string[];
  frameworks: string[];
  packageManager?: string;
  testCommands: string[];
  lintCommands: string[];
  typecheckCommands: string[];
  buildCommands: string[];
  hasECC: boolean;
  summary: string;
}
```

### 6.3 Planner

The Planner proposes a decomposition. It is not assumed to be correct. Workers validate the plan during task preflight and can challenge it.

```text
Goal + RepositoryProfile + Constraints
        ↓
      Planner
        ↓
  Proposed TaskGraph
        ↓
Task negotiation / preflight
        ↓
 Accepted executable graph
```

## 7. Task Contract and Preflight

A task should not immediately become executable after planning. The assigned worker or team first receives a Task Contract and confirms that the work is coherent.

### 7.1 Task Contract

```text
TASK-14 CONTRACT

Objective
Prevent duplicate payment creation.

Allowed scope
payments/service.ts
payments/idempotency/**

Forbidden changes
provider API contract
legacy-payments/**

Acceptance criteria
- concurrent requests create one payment
- retry returns existing result
- public API remains compatible
- previous failure is covered by a test

Dependencies
TASK-11 verified
```

### 7.2 Preflight decision

```text
type TaskPreflightDecision =
  | "accept"
  | "challenge"
  | "need_context"
  | "need_dependency"
  | "recommend_collaboration"
  | "recommend_split"
  | "recommend_merge";

interface TaskPreflightResult {
  decision: TaskPreflightDecision;
  understanding: string;
  concerns: string[];
  missingContext: string[];
  suggestedDependencies: string[];
  collaboration?: CollaborationProposal;
}
```

### 7.3 Negotiation lifecycle

```text
proposed
   ↓
preflight
   ↓
negotiating  ←→  planner / peer agents / user
   ↓
accepted
   ↓
ready
   ↓
running
```

This protects the system from a common failure mode: an agent faithfully implementing a bad or contradictory task instead of questioning it.

## 8. Router Agent: Dynamic Team Formation

A dedicated Router Agent answers one narrow question: given this task and current context, what is the minimum sufficient execution strategy and what roles are needed?

The first implementation uses the OpenAI Responses API and strict JSON-schema output. The provider and model are configurable. As of September 2026, a cost-efficient model such as `gpt-5.6-luna` is appropriate for routine routing, with an optional escalation model such as `gpt-5.6-terra` for ambiguous high-risk decisions. Do not make the control plane depend on a particular model ID.

### 8.1 Router does not

- Write code.
- Change Git.
- Directly assign OS processes.
- Change task state.
- Override permissions.
- Merge branches.
- Bypass verification.
### 8.2 Router considers

- Task size and type.
- Complexity.
- Uncertainty.
- Production/security risk.
- Affected change surface.
- Dependency ambiguity.
- Need for independent validation.
- Available agent capabilities.
- Historical performance when sufficient data exists.
- Current worker availability and concurrency.
- Budget/cost preference.
- Expected coordination overhead.
### 8.3 Minimum sufficient team

The Router must explicitly prefer the smallest team that can safely perform the work. Collaboration is not inherently better; it consumes money, time and context.

```text
tiny/simple        → 1 worker
medium             → 1 worker, optional reviewer
high-risk          → implementer + independent reviewer
high-uncertainty   → parallel investigation
hard bug           → reproduction + investigation + synthesis
architecture       → proposal + critique / feasibility check
high-risk + high-uncertainty → collaborative team
```

### 8.4 Structured routing output

```text
interface RoutingDecision {
  strategy: CollaborationMode;
  complexity: "low" | "medium" | "high";
  risk: "low" | "medium" | "high";
  uncertainty: "low" | "medium" | "high";
  teamSize: number;
  roles: RoleRequest[];
  communication: {
    required: boolean;
    initialAlignment: boolean;
    synthesisBeforeImplementation: boolean;
  };
  reason: string;
}

interface RoleRequest {
  role: AgentRole;
  requiredCapabilities: string[];
  objective: string;
  preferredAgent?: string;
}
```

### 8.5 Router prompt contract

```text
You are the TaskForge routing controller.

Your only responsibility is deciding how an engineering task should be staffed and executed.
You do not implement code, change tasks, execute commands, or control Git.

Evaluate complexity, uncertainty, risk, task size, change surface, dependency ambiguity,
need for independent validation, available capabilities, historical performance, availability,
and expected collaboration cost.

Choose the minimum team required to safely complete the task.
Prefer a single agent for straightforward work.
Escalate collaboration only when the expected benefit justifies extra cost and coordination.
Return only the strict structured routing decision.
```

### 8.6 Fallback

If the OpenAI Router is unavailable, TaskForge falls back to a deterministic `StaticRoutingStrategy`. Router availability must never be required for control-plane integrity.

## 9. Roles, Agent Selection and Capabilities

The Router should primarily request roles and capabilities, not brands. A separate Agent Selector maps the requested role to an available harness using capability, performance, availability, cost and user policy.

```text
Task
 ↓
Router: "need reproduction engineer + architecture reviewer"
 ↓
Agent Selector
 ├─ reproduction engineer → Codex
 └─ architecture reviewer → Claude
```

### 9.1 Agent adapter

```text
interface AgentAdapter {
  id: string;
  name: string;
  detect(): Promise<boolean>;
  capabilities(): Promise<AgentCapabilities>;
  execute(task: AgentAssignment, context: AgentContext): Promise<AgentResult>;
  send?(sessionId: string, message: AgentMessage): Promise<void>;
  cancel(sessionId: string): Promise<void>;
}
```

### 9.2 Agent roles

```text
type AgentRole =
  | "lead"
  | "implementer"
  | "researcher"
  | "architecture_reviewer"
  | "reviewer"
  | "critic"
  | "tester"
  | "reproduction_engineer"
  | "security_reviewer"
  | "integrator";
```

## 10. Collaboration Strategies

TaskForge must treat multi-agent execution as a first-class strategy. One task can contain multiple assignments and an internal execution graph.

```text
type CollaborationMode =
  | "single"
  | "pair"
  | "parallel"
  | "partitioned"
  | "competitive"
  | "review"
  | "collaborative"
  | "swarm";
```

| Mode | Meaning | Typical use |
| --- | --- | --- |
| single | One worker owns the task | Straightforward implementation |
| pair | Driver + active partner/reviewer | Sensitive implementation, difficult refactor |
| parallel | Several workers independently investigate the same question | High uncertainty / root-cause analysis |
| partitioned | One business task split into different sub-areas | Large feature with clean internal boundaries |
| competitive | Independent solutions in isolated worktrees | Difficult bug/algorithm when alternatives are valuable |
| review | Implementer + independent reviewer(s) | High risk or quality gate |
| collaborative | Roles coordinate through messages and synthesis | Complex cross-cutting task |
| swarm | Team shape can change dynamically during the task | Experimental / later-stage autonomous operation |

### 10.1 Task execution strategy

```text
interface TaskExecutionStrategy {
  mode: CollaborationMode;
  assignments: AgentAssignment[];
  maxAgents?: number;
  synthesis?: SynthesisStrategy;
  workspaceStrategy: WorkspaceStrategy;
}

interface AgentAssignment {
  id: string;
  taskId: string;
  agentId: string;
  role: AgentRole;
  objective: string;
  status: AssignmentStatus;
}
```

## 11. Emergent Collaboration and Escalation

Collaboration is not only planned up front. A worker may discover during preflight or execution that the task is more complex than expected and request help.

```text
Codex begins TASK-15 alone
        ↓
Verification fails twice
        ↓
Codex reports unexpected consistency behavior
        ↓
CollaborationRequest
        ↓
Router reevaluates staffing
        ↓
Claude joins for architecture analysis
Gemini joins for independent flow investigation
        ↓
Task continues with expanded team
```

### 11.1 Collaboration proposal

```text
interface CollaborationProposal {
  reason: string;
  requestedRoles: AgentRole[];
  suggestedAgents?: string[];
  expectedBenefit: string;
  urgency: "normal" | "high";
}
```

An agent may recommend a specific peer, but role/capability requests are preferred so the scheduler remains provider-neutral.

### 11.2 Escalation triggers

- Ambiguous acceptance criteria discovered in code.
- Unexpected dependency or overlapping change boundary.
- Repeated verification failure.
- Security or consistency risk.
- Agent confidence materially drops because evidence conflicts.
- Task needs independent reproduction or validation.
- Agent detects that proposed task split is unsafe.
## 12. Agent-to-Agent Communication Bus

Agents need a controlled way to exchange technical questions and evidence. Do not create an unbounded group chat.

```text
Claude  ── question ─────────────► Codex
Claude  ◄─ evidence/answer ───────── Codex
Gemini  ── challenge ───────────────► Claude
                 │
                 ▼
             TaskForge
     persists message metadata,
     enforces limits and routes messages
```

### 12.1 Message types

```text
type AgentMessageType =
  | "question"
  | "answer"
  | "challenge"
  | "evidence"
  | "proposal"
  | "review"
  | "handoff"
  | "blocker"
  | "context_request";
```

### 12.2 Message record

```text
interface AgentMessage {
  id: string;
  runId: string;
  taskId: string;
  fromAssignmentId: string;
  toAssignmentId?: string;
  type: AgentMessageType;
  body: string;
  artifactRefs?: string[];
  createdAt: Date;
}
```

### 12.3 Guardrails

```text
collaboration:
  maxAgentsPerTask: 3
  maxMessagesPerRound: 6
  maxRounds: 3
  requireReasonForEscalation: true
  requireSynthesisAfterParallelInvestigation: true
```

These values are configurable. The purpose is to prevent endless agent-to-agent discussion and runaway token use.

## 13. Synthesis and Internal Task Graphs

A business-level Task remains one node in the main TaskGraph, but a collaborative task can contain an internal AssignmentGraph.

```text
TASK-12: Fix payment duplication

                 Claude investigate
                /
Task start ─────┼── Gemini investigate
                \n                 Codex reproduce
                       │
                       ▼
                    synthesis
                       │
                 Claude design
                       │
                 Codex implement
                       │
            ┌──────────┴──────────┐
            ▼                     ▼
       Gemini review         Claude review
            └──────────┬──────────┘
                       ▼
                    verify
```

Synthesis may combine evidence rather than select a “winner.” For example, Claude architecture + Codex implementation + Gemini edge-case test can all contribute to the final result.

## 14. Complete System Architecture

```text
                              HUMAN
                                │
                                ▼
                         Interactive CLI (tf)
                                │
                                ▼
                       Conversation Runtime
                                │
                                ▼
                          Operator Agent
                                │
                 ┌──────────────┼──────────────┐
                 ▼              ▼              ▼
              Planner       Run Queries      Commands
                 │                              │
                 ▼                              │
           Proposed TaskGraph                   │
                 │                              │
                 ▼                              │
        Task Negotiation / Preflight             │
                 │                              │
                 ▼                              │
            OpenAI Router                       │
        "team shape + roles"                    │
                 │                              │
                 ▼                              │
           Agent Selector                       │
                 │                              │
                 └──────────────┬───────────────┘
                                ▼
                    Deterministic Scheduler
                                │
                 ┌──────────────┼──────────────┐
                 ▼              ▼              ▼
              Claude          Codex          Gemini
                 ↕              ↕              ↕
                    Communication Bus
                                │
                         isolated worktrees
                                │
                                ▼
                          Verification
                                │
                             Review
                                │
                           Integration
                                │
                                ▼
                         Human result/PR

Horizontal: SQLite state • Git • events • plugins • telemetry • security
```

## 15. Core Domain Model

### 15.1 Task

```text
interface Task {
  id: string;
  goalId: string;
  title: string;
  description: string;
  type: TaskType;
  status: TaskStatus;
  dependencies: string[];
  contract: TaskContract;
  executionStrategy?: TaskExecutionStrategy;
  acceptanceCriteria: string[];
  createdAt: Date;
}
```

### 15.2 Task lifecycle

```text
proposed
   ↓
preflight
   ↓
negotiating
   ↓
accepted
   ↓
ready
   ↓
assigned
   ↓
running
   ↓
completed
   ↓
verification
   ↓
verified
   ↓
integrated

Failure paths: failed → retrying / reassigned / collaborative_escalation / blocked
```

### 15.3 DAG rule

A task becomes runnable only when it is accepted, ready and every declared dependency is verified. Graph changes proposed by agents are validated and applied by deterministic graph-management code.

## 16. Workspaces, Git and Concurrency

Same task does not mean same writable filesystem. Parallel writers must be isolated.

```text
.taskforge/worktrees/
└── TASK-12/
    ├── codex-implementer/
    ├── claude-alternative/
    └── gemini-experiment/
```

### 16.1 Workspace rules by strategy

| Strategy | Workspace behavior |
| --- | --- |
| single | One task worktree |
| parallel investigation | Shared read-only snapshot or separate read-only contexts |
| pair | One driver worktree; partner reviews via diff/messages unless explicitly safe |
| competitive | One isolated writable worktree per solution |
| partitioned | Separate worktrees per assignment; integrate after verified boundaries |
| review | Reviewer receives diff/read-only view; no silent edits |
| collaborative | Writer assignments isolated; synthesis/integration is explicit |

### 16.2 Git safety

- Inspect dirty working tree before starting.
- Never clean or reset user changes silently.
- Never allow two parallel writable assignments to share a worktree.
- Preserve failed worktrees until cleanup policy permits deletion.
- Never push or merge to main automatically in v0.x.
## 17. Execution Runtime

The runtime manages processes and sessions. It does not make planning or staffing decisions.

```text
interface ExecutionRecord {
  id: string;
  runId: string;
  taskId: string;
  assignmentId: string;
  agentId: string;
  pid?: number;
  startedAt: Date;
  finishedAt?: Date;
  exitCode?: number;
  status: ExecutionStatus;
  logPath: string;
}
```

- Start, stream and terminate processes.
- Capture stdout/stderr.
- Apply timeout and cancellation.
- Record session IDs.
- Expose live activity to the conversation runtime.
- Support agent steering/messages where the adapter/harness allows it.
## 18. Verification, Review and Rework

> **An agent saying “done” is not evidence of completion.**

```text
Agent work completed
        ↓
Repository changes exist?
        ↓
Task acceptance checks
        ↓
Tests / lint / typecheck / build
        ↓
Required independent reviews
        ↓
Verified
```

### 18.1 Review result

```text
interface ReviewFinding {
  severity: "critical" | "major" | "minor" | "suggestion";
  description: string;
  file?: string;
  line?: number;
}

interface ReviewResult {
  approved: boolean;
  findings: ReviewFinding[];
}
```

### 18.2 Rework policy

Critical or major findings return work to rework. Rework cycles are bounded. Repeated failure can trigger Router reevaluation and collaborative escalation instead of blindly asking the same worker again.

## 19. Integration

Verified commits flow into a run-specific integration branch. Early versions should prefer known commits/cherry-picks because they make provenance explicit.

```text
taskforge/run-<run-id>

TASK-03 verified commit ─┐
TASK-04 verified commit ─┼─► integration branch ─► final verification
TASK-05 verified commit ─┘
```

Merge conflicts initially block the run. Autonomous conflict resolution is a later capability and must never silently override verified work.

## 20. Persistence, Events and Auditability

SQLite stores control-plane state; Git stores code state. Every meaningful lifecycle transition emits an event.

### 20.1 Initial tables

```text
runs
goals
constraints
tasks
task_dependencies
task_contracts
assignments
executions
agent_messages
routing_decisions
preflight_results
reviews
verification_results
workspaces
plugins
events
metrics
```

### 20.2 Event examples

```text
RUN_CREATED
GOAL_UPDATED
PLAN_PROPOSED
TASK_PREFLIGHT_STARTED
TASK_CHALLENGED
TASK_ACCEPTED
ROUTING_REQUESTED
ROUTING_DECIDED
ASSIGNMENT_CREATED
AGENT_MESSAGE_SENT
COLLABORATION_ESCALATED
TASK_STARTED
TASK_COMPLETED
VERIFY_STARTED
VERIFY_COMPLETED
REVIEW_COMPLETED
INTEGRATION_COMPLETED
```

### 20.3 Audit reconstruction

Given a run ID, TaskForge must be able to reconstruct the goal, user constraints, proposed and accepted plans, routing decisions, assignments, messages, process activity, Git commits, verification, reviews, rework and final integration state.

## 21. Plugin System and ECC

```text
interface TaskForgePlugin {
  name: string;
  version: string;
  capabilities(): PluginCapability[];
  onRunStart?(ctx: RunContext): Promise<void>;
  beforePlan?(ctx: PlanContext): Promise<void>;
  afterPlan?(graph: TaskGraph): Promise<void>;
  beforeTask?(ctx: TaskContext): Promise<TaskContext>;
  afterTask?(result: TaskResult): Promise<void>;
  verify?(ctx: VerificationContext): Promise<PluginVerificationResult>;
  onRunComplete?(ctx: RunContext): Promise<void>;
}
```

TaskForge must run correctly with zero plugins.

### 21.1 ECC integration

ECC is the first real plugin. TaskForge should detect it and selectively use relevant capabilities rather than copying ECC internals into the core.

| ECC can enhance | TaskForge still owns |
| --- | --- |
| Skills and engineering workflows | Planning and task graph |
| Rules / standards | Routing and team formation |
| Memory / learned patterns | Scheduling and process lifecycle |
| Security scanning | Worktree isolation and permissions |
| Quality gates | Authoritative verification state |
| Harness configuration | Git integration and final branch |
| Continuous learning | TaskForge telemetry and performance engine |

### 21.2 Selective capability loading

```text
TASK: backend OAuth implementation

ECC selected:
✓ auth/security
✓ backend patterns
✓ TDD
✓ code review

Not loaded:
× ML
× Kubernetes
× unrelated frontend skills
```

## 22. OpenAI Router Integration

The Router should use the OpenAI Responses API with strict structured output so TaskForge consumes a validated routing decision instead of parsing free-form prose. The API integration must live behind a provider interface so another router provider can replace it later.

### 22.1 Provider interface

```text
interface RoutingProvider {
  route(input: RoutingInput): Promise<RoutingDecision>;
}

class OpenAIRoutingProvider implements RoutingProvider { ... }
class StaticRoutingProvider implements RoutingProvider { ... }
```

### 22.2 Configuration

```text
router:
  provider: openai
  model: gpt-5.6-luna
  escalationModel: gpt-5.6-terra
  reasoning: low
  timeoutSeconds: 20
  fallback: static

  budget:
    maxAgentsPerTask: 3
    preference: balanced
```

Model IDs are configuration, not architecture. They may change without a core release.

### 22.3 Routing input

```text
{
  "task": { ... },
  "repository": { ... },
  "signals": {
    "complexity": "unknown",
    "risk": "high",
    "uncertainty": "high"
  },
  "availableAgents": [ ... ],
  "agentCapabilities": { ... },
  "historicalPerformance": { ... },
  "availability": { ... },
  "budget": { ... }
}
```

### 22.4 Routing is advisory, scheduler is authoritative

The Router may prefer Codex for a role, but the Scheduler can choose another eligible worker if Codex is unavailable, disallowed, over concurrency limit or too costly under the current policy.

## 23. Security and Trust Boundaries

- Agents execute code and must be treated as powerful automation.
- No automatic sudo.
- No broad inheritance of parent environment variables.
- Secrets are allowlisted/provider-scoped.
- Destructive commands are blocked or require approval.
- Writable paths are constrained to the assignment workspace.
- Agent messages cannot directly mutate state.
- Plugin errors cannot corrupt core run state.
- External AI services can advise but do not own control-plane integrity.
- No automatic push or merge to protected branches in early releases.
### 23.1 Environment policy

```text
environment:
  inherit: false
  allow:
    - NODE_ENV
  denyPatterns:
    - "*PASSWORD*"
    - "*SECRET*"
    - "*TOKEN*"

Provider credentials are explicitly mapped per adapter/provider.
```

### 23.2 Prompt injection / repository instructions

Repository content, issue text, logs and agent-to-agent messages are untrusted inputs. The Operator, Planner and Router prompts must clearly separate system policy from repository-provided text. Tool permissions and deterministic policies must enforce boundaries even when an agent is misled.

## 24. Configuration

```text
version: 1

ui:
  mode: interactive

planner:
  agent: claude

router:
  provider: openai
  model: gpt-5.6-luna
  escalationModel: gpt-5.6-terra
  fallback: static

execution:
  maxParallelTasks: 3
  defaultTimeoutMinutes: 30

collaboration:
  maxAgentsPerTask: 3
  maxMessagesPerRound: 6
  maxRounds: 3

agents:
  claude:
    enabled: true
    maxParallel: 1
  codex:
    enabled: true
    maxParallel: 2
  gemini:
    enabled: true
    maxParallel: 1

verification:
  tests: true
  lint: true
  typecheck: true
  review: true
  maxReworkCycles: 2

plugins:
  ecc:
    enabled: auto
    mode: selective

security:
  allowAutomaticWriteOutsideWorktree: false
  allowAutomaticPush: false
```

## 25. CLI and Operator Surface

| Entry | Purpose |
| --- | --- |
| tf | Start interactive conversation |
| taskforge | Long alias for `tf` |
| tf exec <goal> | Headless run for automation |
| tf doctor | Environment/provider/worktree checks |
| tf inspect <run> | Non-interactive run inspection |
| tf resume <run> | Resume interrupted run later |
| tf cleanup | Explicit cleanup of eligible artifacts |

### 25.1 In-session deterministic shortcuts

```text
/agents
/tasks
/task TASK-12
/plan
/cost
/pause
/resume
/logs TASK-12
/approve
/reject
/exit
```

Natural language equivalents must remain available so users do not need to memorize slash commands.

## 26. Telemetry and Learning

Telemetry begins early; adaptive routing comes later. Never invent agent performance superiority before sufficient data exists.

- Task type and complexity signals.
- Chosen strategy and team size.
- Agent/role assignments.
- Duration and attempts.
- First-pass verification result.
- Review finding counts/severity.
- Rework cycles.
- Collaboration escalation frequency.
- Message rounds.
- Integration success.
- Token usage and cost when reliably exposed.
### 26.1 Performance dimensions

```text
agent × role × task_type × language × framework × repository × complexity

Metrics:
- success rate
- first-pass verification
- average duration
- cost per successful task
- review quality
- rework rate
- escalation rate
```

### 26.2 Future adaptive routing

```text
score ≈ success_probability × quality_score
        - cost_penalty
        - latency_penalty
        - rework_penalty
        - coordination_penalty

Always show sample size and confidence. Do not hide uncertainty.
```

## 27. Testing Strategy

| Layer | Tests |
| --- | --- |
| Unit | DAG, state machine, intent parsing contracts, routing schema, scheduler, collaboration limits, configuration |
| Integration | SQLite, Git worktrees, process runtime, fake routing provider, agent communication bus, plugins, verification |
| End-to-end | Temporary Git repository + FakeAgents + Router stub + concurrent work + negotiation + commits + integration |
| Optional provider tests | Real Claude/Codex/Gemini/OpenAI smoke tests gated by credentials, never required for normal CI |

### 27.1 FakeAgent

- Accept or challenge preflight.
- Request collaboration.
- Send deterministic messages.
- Succeed, fail or timeout.
- Write a file and commit.
- Return review findings.
- Simulate a conflict or repeated verification failure.
### 27.2 FakeRouter

Tests must use deterministic Router decisions so CI does not require OpenAI credentials and routing behavior is reproducible.

## 28. Technology and Repository Layout

| Concern | Choice |
| --- | --- |
| Language | TypeScript |
| Runtime | Node.js 22+ |
| Package manager | pnpm |
| Schema validation | Zod |
| Persistence | SQLite |
| Git | Native Git CLI |
| Process execution | child_process or execa |
| CLI/TUI | Start lightweight; choose Ink or equivalent only when needed |
| Testing | Vitest |
| Lint/format | ESLint + Prettier |
| CI | GitHub Actions |

```text
taskforge/
├── apps/
│   └── cli/
├── packages/
│   ├── conversation/
│   ├── operator/
│   ├── core/
│   ├── planner/
│   ├── router/
│   ├── negotiation/
│   ├── collaboration/
│   ├── agents/
│   ├── workspace/
│   ├── execution/
│   ├── verification/
│   ├── integration/
│   ├── plugins/
│   ├── telemetry/
│   ├── persistence/
│   └── shared/
├── docs/
├── examples/
└── tests/

Do not create empty packages just to match this tree. Add them as vertical slices require.
```

## 29. Delivery Roadmap

| Phase | Milestone | Scope | Exit criteria |
| --- | --- | --- | --- |
| 0 | Foundation | pnpm workspace, strict TS, config, logging, SQLite, events, CI | `tf --help`; test/lint/typecheck green |
| 1 | Process + Agent runtime | AgentAdapter, FakeAgent, Claude/Codex/Gemini detection & execution | Each adapter can run a trivial isolated task |
| 2 | Git workspace isolation | RepositoryAnalyzer, Git service, WorktreeManager | FakeAgent writes/commits without touching primary tree |
| 3 | Core task/DAG state | Goal, Task, state machine, dependencies, persistence | Deterministic DAG execution primitives |
| 4 | Deterministic scheduler | Runnable queue, concurrency, cancellation, events | Independent fake tasks run in parallel |
| 5 | Verification/integration | Tests/lint/typecheck/build, run branch, cherry-pick | Verified fake work integrates safely |
| 6 | Interactive shell | `tf` session, conversation runtime, slash-command framework | User can inspect/control a fake run conversationally |
| 7 | Operator Agent | Natural-language intents mapped to typed commands | User can pause/reassign/restrict via language |
| 8 | Planner | Structured proposed TaskGraph | Goal → proposed plan with approval |
| 9 | Task Contract + Preflight | Accept/challenge/context/split/merge negotiation | Workers can reject bad tasks before execution |
| 10 | OpenAI Router | Strict structured routing, fallback static strategy | Task → minimum team shape + roles |
| 11 | Agent selector | Role/capability → concrete available worker | Provider-neutral staffing |
| 12 | Collaboration bus | Agent messages, limits, persistence | Pair/parallel collaboration works with FakeAgents |
| 13 | Collaborative execution | AssignmentGraph, synthesis, emergent escalation | One task can involve 2–3 agents safely |
| 14 | Real-agent E2E v0.1 | Claude + Codex + Gemini on real repo | Conversation → team → verified integration branch |
| 15 | Plugin SDK | Plugin hooks/config/error isolation | Core runs with zero plugins |
| 16 | ECC plugin | Selective skills/rules/security/quality gates | ECC removable without core breakage |
| 17 | Telemetry & stats | Routing/execution/rework/cost history | `/cost`, stats and run evidence |
| 18 | Performance engine | Aggregations by role/task/repo | Historical signals with sample sizes |
| 19 | Adaptive routing | History-aware role/agent selection | Adaptive strategy behind feature flag |
| 20 | Advanced UX | Richer TUI task/team graph, streaming status | Operator experience approaches polished coding CLIs |
| 21 | GitHub workflow | Issue → run → PR, evidence summary | Optional automation |
| 22 | Remote workers | Docker/SSH/remote execution | Only after local system is stable |

### 29.1 What must not be built too early

- Distributed control plane.
- Kubernetes backend.
- Hosted account system.
- Web dashboard.
- Vector database.
- ML model training for routing.
- Autonomous merge-conflict resolution.
- Unlimited swarm mode.
- Billing.
## 30. Milestone Demonstrations

### 30.1 Demonstration A: deterministic orchestration

```text
Temporary Git repo
  TASK-A → FakeAgent A → backend file
  TASK-B → FakeAgent B → frontend file
  A+B run concurrently
  TASK-C waits
  verification
  integration branch
```

### 30.2 Demonstration B: negotiation

```text
Planner proposes TASK-X
FakeAgent challenges: task overlaps with TASK-Y
Control plane enters negotiating
Tasks are merged through validated graph update
New task is accepted and executed
```

### 30.3 Demonstration C: collaborative task

```text
TASK: diagnose flaky payment test
Router chooses parallel investigation
Agent A: reproduction
Agent B: code-path analysis
Agent C: DB/event analysis
Messages + evidence
Synthesis
One implementer fixes
Different agent reviews
Verification passes
```

### 30.4 Demonstration D: real interactive run

```text
$ tf
> cria um endpoint HTTP simples com teste e documentação

At least two real workers participate when justified.
Task preflight is visible.
Worktrees are isolated.
Human can ask questions and change constraints during execution.
Final branch passes verification.
```

## 31. Success Metrics

### 31.1 Reliability first

- Task completion rate.
- First-pass verification rate.
- Integration success rate.
- Run recovery/cancellation correctness.
- No corruption of primary working tree.
- Percentage of routing decisions successfully executed.
### 31.2 Collaboration quality

- Collaboration escalation that materially changes outcome.
- Task challenges caught before implementation.
- Reduction in rework after preflight.
- Messages per successful collaborative task.
- Time/cost overhead of collaboration versus single-agent work.
### 31.3 Efficiency later

- Cost per successful task.
- Tokens per successful task.
- Wall-clock savings from useful parallelism.
- Performance by role and agent with sample size.
## 32. Error Taxonomy and Recovery

```text
ConfigurationError
RepositoryError
AgentUnavailableError
AgentExecutionError
RouterUnavailableError
RoutingDecisionError
PlanningError
InvalidTaskGraphError
TaskNegotiationError
WorkspaceCreationError
CollaborationLimitError
VerificationError
ReviewError
IntegrationError
PluginError
```

Failures should be explicit and typed. “Agent failed” is not enough; the system must distinguish provider absence, timeout, process failure, verification failure, collaboration budget exhaustion and control-plane errors.

## 33. Instructions for the Coding Agent Building TaskForge

This section is deliberately written so the entire document can be given to Claude Code, Codex, Gemini/Antigravity or another coding harness. The build agent should treat this document as product intent and architecture constraints, not as an instruction to implement every phase at once.

1. Read this specification before changing code.
1. Do not implement the entire roadmap in one pass.
1. Start with the exact bootstrap milestone below.
1. Before each milestone, inspect existing code and produce a concise plan.
1. Prefer the smallest working vertical slice.
1. Write automated tests before claiming a control-plane behavior works.
1. Run test, lint and typecheck before closing every milestone.
1. Keep provider-specific logic behind adapters/providers.
1. Keep the core functional without OpenAI Router and without ECC.
1. Never silently modify or reset user Git state.
1. Never push or merge to main automatically.
1. Do not create placeholder APIs that pretend unsupported behavior exists.
1. Use structured schemas for AI decisions and intents.
1. Persist authoritative state outside conversation text.
1. Record major architecture changes in ADRs.
1. Keep AGENTS.md/CLAUDE.md concise; point to docs rather than copying the full spec.
### 33.1 Bootstrap implementation request

```text
IMPLEMENTATION START — TASKFORGE

Create a new repository/directory named: taskforge
Primary binary: tf
Long alias: taskforge

Implement ONLY Phases 0–5:
0 Foundation
1 Process + Agent runtime
2 Git workspace isolation
3 Core task/DAG state
4 Deterministic scheduler
5 Verification/integration

Do NOT implement yet:
- conversational Operator Agent
- OpenAI Router API
- Planner LLM
- task negotiation LLM logic
- agent-to-agent communication
- ECC plugin
- adaptive routing
- TUI
- GitHub PR automation
- remote workers

However, define clean interfaces so these later components can be added without redesigning the core.

Required stack:
- TypeScript
- Node.js 22+
- pnpm
- strict TypeScript
- Zod
- SQLite
- Vitest
- ESLint + Prettier
- GitHub Actions
```

```text
Required behavior:
- AgentAdapter interface
- FakeAgent with deterministic success/failure/timeout/write/commit behavior
- Claude Code adapter
- Codex adapter
- Gemini CLI adapter
- agent detection
- process runtime with timeout and cancellation
- RepositoryAnalyzer foundation
- Git service
- WorktreeManager
- Goal / Task / TaskGraph / state machine
- deterministic scheduler with concurrency limits
- verification command runner
- run-specific integration branch
- event persistence
- tests proving parallel isolated FakeAgent work

Before finishing:
1. run all tests
2. run lint
3. run typecheck
4. demonstrate two FakeAgents working concurrently in different worktrees
5. demonstrate a dependent task waiting for both
6. demonstrate verification preventing a bad task from integration
7. document architecture and known limitations
8. STOP and report results; do not continue to Phase 6
```

## 34. Second Build Milestone: Conversation, Negotiation and Router

Only start this after Phases 0–5 are stable and demonstrated.

```text
IMPLEMENT PHASES 6–13:

6 Interactive shell
7 Operator Agent intent layer
8 Planner
9 Task Contract + Preflight / negotiation
10 OpenAI Router provider with strict structured output + static fallback
11 Agent Selector
12 Agent Communication Bus
13 Collaborative Execution / AssignmentGraph / synthesis

Acceptance scenarios:
- `tf` opens an interactive prompt
- natural language can inspect tasks and pause/reassign work
- a worker can challenge a task before execution
- Router can choose single vs collaborative strategy
- Router returns roles/capabilities, not only agent brands
- Router outage falls back safely
- a task can involve 3 FakeAgents in parallel investigation
- agents can exchange bounded structured messages
- synthesis occurs before implementation when configured
- an executing task can request collaboration escalation
- core state changes remain deterministic and audited
```

## 35. External Integration Notes and References

OpenAI Router: use the current OpenAI Responses API structured-output mechanism with strict JSON Schema rather than parsing natural-language routing responses. Keep the implementation behind a provider abstraction because model names and API details can evolve.

ECC: integrate the upstream `affaan-m/ECC` project as an optional capability provider. Do not copy its entire skill catalog into TaskForge or make TaskForge boot dependent on ECC.

References:

- OpenAI API Models: https://platform.openai.com/docs/models
- OpenAI API Structured Outputs / Responses reference: https://platform.openai.com/docs/api-reference
- ECC repository: https://github.com/affaan-m/ECC
## 36. Final Product Principle

> **TaskForge is not “three AIs answering a prompt.”**

It is a conversational engineering control plane in which agents can reason, negotiate, question work, ask peers for help and self-organize into temporary teams, while deterministic software controls state, permissions, concurrency, Git isolation, verification and integration.

```text
Human intent
    ↓
Conversation
    ↓
Plan proposal
    ↓
Task negotiation
    ↓
Minimum sufficient team
    ↓
Self-organizing collaboration
    ↓
Deterministic execution
    ↓
Independent verification
    ↓
Human-reviewable result
```
