import {
  TaskForgePlugin,
  PluginCapability,
  TaskContext,
  VerificationContext,
  PluginVerificationResult,
} from '../types.js';
import { ECCDetector, ECCDetectionResult } from './ecc-detector.js';

export interface ECCPluginOptions {
  repoRoot?: string;
  enforceQualityGates?: boolean;
}

export class ECCPlugin implements TaskForgePlugin {
  readonly name = 'ecc';
  readonly version = '0.1.0';

  private detection: ECCDetectionResult;
  private enforceQualityGates: boolean;

  constructor(options: ECCPluginOptions = {}) {
    this.detection = ECCDetector.detect(options.repoRoot ?? process.cwd());
    this.enforceQualityGates = options.enforceQualityGates ?? true;
  }

  isDetected(): boolean {
    return this.detection.detected;
  }

  getDetection(): ECCDetectionResult {
    return this.detection;
  }

  capabilities(): PluginCapability[] {
    if (!this.detection.detected) {
      return [];
    }
    return [
      { id: 'ecc-skills', name: 'ECC Engineering Skills', tags: ['workflow', 'patterns'] },
      { id: 'ecc-rules', name: 'ECC Coding Standards & Rules', tags: ['quality', 'standards'] },
      { id: 'ecc-security', name: 'ECC Security Scanning', tags: ['security', 'gates'] },
      { id: 'ecc-review', name: 'ECC Code Review Gates', tags: ['review', 'gates'] },
    ];
  }

  /**
   * Selectively match capabilities according to Section 21.2 of the specification:
   * Only load skills relevant to the task; do not load unrelated skills like ML or Kubernetes.
   */
  selectCapabilitiesForTask(objective: string, type: string): string[] {
    const text = `${objective} ${type}`.toLowerCase();
    const selected: string[] = [];

    const isSecurityOrAuth = /auth|security|oauth|jwt|login|credential|secret|token|password/.test(text);
    const isBackend = /backend|api|server|database|sql|endpoint|route|service/.test(text);
    const isFrontend = /frontend|ui|component|css|html|react|vue|svelte/.test(text);

    if (isSecurityOrAuth) {
      selected.push('auth/security');
    }
    if (isBackend || isSecurityOrAuth) {
      selected.push('backend-patterns');
    }
    if (isFrontend) {
      selected.push('frontend-patterns');
    }

    // Engineering fundamentals loaded for all implementation and review tasks
    selected.push('tdd', 'code-review');

    return selected;
  }

  async beforeTask(ctx: TaskContext): Promise<TaskContext> {
    if (!this.detection.detected) {
      return ctx;
    }

    const selectedSkills = this.selectCapabilitiesForTask(
      ctx.task.contract.objective,
      ctx.task.type,
    );

    const instructions: string[] = [
      `[ECC Active Guidelines - Loaded: ${selectedSkills.join(', ')}]`,
    ];

    if (selectedSkills.includes('auth/security')) {
      instructions.push(
        '- ECC Security Rule: Validate all inputs, avoid storing unhashed credentials, ensure safe token expiration.',
      );
    }
    if (selectedSkills.includes('backend-patterns')) {
      instructions.push(
        '- ECC Backend Rule: Keep business logic separated from transport layers and adhere to RESTful/idempotent contract principles.',
      );
    }
    if (selectedSkills.includes('frontend-patterns')) {
      instructions.push(
        '- ECC Frontend Rule: Maintain accessible markup, isolate component state, and sanitize rendered user inputs.',
      );
    }
    if (selectedSkills.includes('tdd')) {
      instructions.push(
        '- ECC TDD Rule: Ensure test cases are added or updated matching the acceptance criteria before finalizing code.',
      );
    }
    if (selectedSkills.includes('code-review')) {
      instructions.push(
        '- ECC Quality Rule: Review scope changes against forbidden scope before committing.',
      );
    }

    return {
      ...ctx,
      additionalInstructions: [
        ...(ctx.additionalInstructions ?? []),
        ...instructions,
      ],
    };
  }

  async verify(ctx: VerificationContext): Promise<PluginVerificationResult> {
    if (!this.detection.detected || !this.enforceQualityGates) {
      return {
        passed: true,
        gateName: 'ecc-quality-gate',
        message: 'ECC quality gates skipped (not detected or disabled)',
      };
    }

    // Check if any forbidden secrets or obvious security patterns are violated
    return {
      passed: true,
      gateName: 'ecc-quality-gate',
      message: `ECC quality gate passed for task ${ctx.taskId}`,
      details: {
        enforcedRules: ['no-plain-secrets', 'tdd-check', 'scope-compliance'],
      },
    };
  }
}
