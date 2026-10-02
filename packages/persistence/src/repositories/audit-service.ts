import {
  TaskForgeEvent,
} from '@taskforge/shared';
import { EventRepository } from './event-repository.js';
import { GoalRecord, GoalRepository } from './goal-repository.js';
import { RunRecord, RunRepository } from './run-repository.js';
import { TaskRecord, TaskRepository } from './task-repository.js';

export interface RunAuditReport {
  run: RunRecord;
  goal?: GoalRecord;
  tasks: TaskRecord[];
  events: TaskForgeEvent[];
}

export class AuditService {
  constructor(
    private runRepo: RunRepository,
    private goalRepo: GoalRepository,
    private taskRepo: TaskRepository,
    private eventRepo: EventRepository,
  ) {}

  reconstructRun(runId: string): RunAuditReport | undefined {
    const run = this.runRepo.get(runId);
    if (!run) return undefined;

    const goal = run.goalId ? this.goalRepo.get(run.goalId) : undefined;
    const tasks = this.taskRepo.listByRun(runId);
    const events = this.eventRepo.listByRun(runId);

    return {
      run,
      goal,
      tasks,
      events,
    };
  }
}
