// =============================================================================
// Task Registry — Maintains the task tree for Coordinator-Worker orchestration
// =============================================================================

import { randomUUID } from "node:crypto";
import type { TaskEntry, TaskStatus } from "../types/orchestration.js";
import type { AgentId } from "../types/agents.js";

export class TaskRegistry {
  private tasks = new Map<string, TaskEntry>();
  private taskTree = new Map<string, string[]>(); // parentTaskId → child task IDs

  /**
   * Create a new task.
   */
  createTask(params: {
    description: string;
    parentTaskId?: string;
    expectedDeliverable: TaskEntry["expectedDeliverable"];
  }): TaskEntry {
    const taskId = `task-${randomUUID().slice(0, 8)}`;

    const task: TaskEntry = {
      taskId,
      parentTaskId: params.parentTaskId,
      description: params.description,
      status: "pending",
      expectedDeliverable: params.expectedDeliverable,
      createdAt: performance.now(),
    };

    this.tasks.set(taskId, task);

    // Add to tree
    if (params.parentTaskId) {
      const children = this.taskTree.get(params.parentTaskId) ?? [];
      children.push(taskId);
      this.taskTree.set(params.parentTaskId, children);
    }

    return task;
  }

  /**
   * Assign a task to a worker agent.
   */
  assignTask(taskId: string, agentId: AgentId): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    task.assignedAgentId = agentId;
    task.status = "claimed";
    return true;
  }

  /**
   * Update task status.
   */
  updateStatus(
    taskId: string,
    status: TaskStatus,
    resultSummary?: string,
    errorMessage?: string,
  ): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    task.status = status;

    if (status === "active" && !task.startedAt) {
      task.startedAt = performance.now();
    }

    if (status === "completed" || status === "failed") {
      task.completedAt = performance.now();
      if (resultSummary) task.resultSummary = resultSummary;
      if (errorMessage) task.errorMessage = errorMessage;
    }

    return true;
  }

  /**
   * Get a task by ID.
   */
  getTask(taskId: string): TaskEntry | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Get all tasks assigned to a specific agent.
   */
  getTasksByAgent(agentId: AgentId): TaskEntry[] {
    return [...this.tasks.values()].filter(
      (t) => t.assignedAgentId === agentId,
    );
  }

  /**
   * Get the full task tree for TUI overlay display.
   */
  getTaskTree(): {
    roots: TaskEntry[];
    children: Map<string, TaskEntry[]>;
  } {
    const roots: TaskEntry[] = [];
    const childrenMap = new Map<string, TaskEntry[]>();

    for (const [taskId, task] of this.tasks) {
      if (!task.parentTaskId) {
        roots.push(task);
      } else {
        const siblings = childrenMap.get(task.parentTaskId) ?? [];
        siblings.push(task);
        childrenMap.set(task.parentTaskId, siblings);
      }
    }

    return { roots, children: childrenMap };
  }

  /**
   * All tasks.
   */
  getAllTasks(): TaskEntry[] {
    return [...this.tasks.values()];
  }
}
