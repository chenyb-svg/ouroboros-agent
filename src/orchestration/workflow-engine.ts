// =============================================================================
// Workflow Engine — Drives sequential/parallel/interactive steps (Phase 6+)
// =============================================================================

import { randomUUID } from "node:crypto";
import type { WorkflowDefinition, WorkflowStep, WorkflowInstanceState, WorkflowStepState, StepStatus } from "../types/workflow.js";
import type { ParsedSlashCommand } from "../cli/slash-parser.js";
import type { EventBus } from "../bus/event-bus.js";

export class WorkflowEngine {
  private instances = new Map<string, WorkflowInstanceState>();
  private bus: EventBus;
  private sessionId: string;
  private onDelegate: (agentId: string, task: string, tools: string[], budget?: any) => Promise<{ summary: string; confidence: string; success: boolean; artifacts?: string[]; details?: string }>;
  private onRender: (text: string) => void;
  private resumeResolver: (() => void) | null = null;

  constructor(
    bus: EventBus,
    sessionId: string,
    callbacks: {
      onDelegate: (agentId: string, task: string, tools: string[], budget?: any) => Promise<{ summary: string; confidence: string; success: boolean; artifacts?: string[]; details?: string }>;
      onRender: (text: string) => void;
    },
  ) {
    this.bus = bus;
    this.sessionId = sessionId;
    this.onDelegate = callbacks.onDelegate;
    this.onRender = callbacks.onRender;
  }

  /** Invoke a workflow with parsed slash command input */
  async invoke(
    workflow: WorkflowDefinition,
    parsed: ParsedSlashCommand,
  ): Promise<WorkflowInstanceState> {
    const instanceId = `wf-${randomUUID().slice(0, 8)}`;
    const steps: WorkflowStepState[] = workflow.steps.map((s) => ({
      stepId: s.id,
      name: s.name,
      status: "pending" as StepStatus,
      attempts: 0,
      tokensUsed: 0,
    }));

    const state: WorkflowInstanceState = {
      workflowId: workflow.id,
      instanceId,
      status: "running",
      steps,
      currentStepIndex: 0,
      sharedState: { input: parsed },
      startedAt: Date.now(),
    };

    this.instances.set(instanceId, state);

    // Emit workflow started
    this.emitWorkflowEvent("WORKFLOW_STARTED", instanceId, workflow.id);

    switch (workflow.type) {
      case "sequential":
        await this.runSequential(workflow, state);
        break;
      case "parallel":
        await this.runParallel(workflow, state);
        break;
      case "interactive":
        await this.runSequential(workflow, state, true);
        break;
    }

    state.completedAt = Date.now();
    this.emitWorkflowEvent("WORKFLOW_COMPLETED", instanceId, workflow.id);
    return state;
  }

  /** Get instance state */
  getState(instanceId: string): WorkflowInstanceState | undefined {
    return this.instances.get(instanceId);
  }

  /** Resume paused interactive workflow — actually continues the step loop */
  resume(instanceId: string, userFeedback: string): void {
    const state = this.instances.get(instanceId);
    if (!state) return;
    state.userFeedback = userFeedback;
    if (state.status === "paused") {
      state.status = "running";
      this.resumeResolver?.();
      this.resumeResolver = null;
    }
  }

  /** Cancel running workflow */
  cancel(instanceId: string): void {
    const state = this.instances.get(instanceId);
    if (state) {
      state.status = "failed";
      this.resumeResolver?.();
      this.resumeResolver = null;
    }
  }

  // ---- Private ----

  private async runSequential(
    workflow: WorkflowDefinition,
    state: WorkflowInstanceState,
    interactive: boolean = false,
  ): Promise<void> {
    for (let i = 0; i < workflow.steps.length; i++) {
      state.currentStepIndex = i;
      const step = workflow.steps[i];
      const stepState = state.steps[i];

      // Evaluate step condition — skip (fail-open) if not met
      if (step.condition && !this.evaluateCondition(step.condition, workflow, state)) {
        stepState.status = "skipped";
        this.onRender(`  ⏭ Step ${i + 1}/${workflow.steps.length}: ${step.name} skipped (condition not met)`);
        continue;
      }

      stepState.status = "running";
      stepState.startedAt = Date.now();
      this.emitStepEvent(stepState, i, workflow.steps.length);

      try {
        // Interpolate prompt template
        const prompt = this.interpolate(step.promptTemplate, state);

        // Delegate to agent
        const result = await this.onDelegate(
          step.agent,
          prompt,
          step.tools ?? [],
          step.budget,
        );

        stepState.status = "completed";
        stepState.result = {
          summary: result.summary,
          confidence: result.confidence,
        };
        stepState.tokensUsed = 100; // mock

        // Store output in shared state
        if (step.outputKey) {
          state.sharedState[step.outputKey] = result.summary;
        }
        // Also store by step index for template refs
        state.sharedState[`steps[${i}].output.summary`] = result.summary;
        state.sharedState[`steps[${i}].output.confidence`] = result.confidence;

        this.onRender(`  ✅ Step ${i + 1}/${workflow.steps.length}: ${step.name} complete`);

        // Interactive mode: pause after each step, wait for resume()
        if (interactive && i < workflow.steps.length - 1) {
          state.status = "paused";
          this.emitWorkflowEvent("WORKFLOW_PAUSED", state.instanceId, workflow.id);
          await new Promise<void>((resolve) => { this.resumeResolver = resolve; });
          // resume() flips status to "running"; cancel() flips to "failed". TS can't see the mutation.
          if ((state.status as string) === "failed") return; // cancelled while paused
          state.status = "running";
          continue; // proceed to next step
        }
      } catch (err: any) {
        stepState.status = "failed";
        stepState.error = err.message ?? String(err);
        this.onRender(`  ❌ Step ${i + 1}/${workflow.steps.length}: ${step.name} failed`);

        if (step.onError) {
          switch (step.onError.action) {
            case "retry":
              if (stepState.attempts < (step.onError.maxRetries ?? 3)) {
                stepState.attempts++;
                stepState.status = "pending";
                i--; // Re-run this step
                this.onRender(`  🔄 Retrying step ${i + 1} (attempt ${stepState.attempts})`);
                continue;
              }
              break;
            case "fallback": {
              const fallbackStepId = (step.onError as { action: "fallback"; stepId: string }).stepId;
              const fallbackIdx = workflow.steps.findIndex((s) => s.id === fallbackStepId);
              if (fallbackIdx >= 0) {
                i = fallbackIdx - 1;
                this.onRender(`  ⤵️ Falling back to step: ${fallbackStepId}`);
                continue;
              }
              break;
            }
          }
        }
        state.status = "failed";
        return;
      }

      stepState.completedAt = Date.now();
    }

    state.status = "completed";
  }

  private async runParallel(
    workflow: WorkflowDefinition,
    state: WorkflowInstanceState,
  ): Promise<void> {
    // Build DAG: find steps with no unmet dependencies
    const completed = new Set<string>();
    const pending = new Set(workflow.steps.map((s) => s.id));

    while (pending.size > 0) {
      // Mark condition-skipped steps so they can't deadlock the dependency check
      for (const s of workflow.steps) {
        if (pending.has(s.id) && s.condition && !this.evaluateCondition(s.condition, workflow, state)) {
          const ss = state.steps.find((x) => x.stepId === s.id);
          if (ss) { ss.status = "skipped"; ss.completedAt = Date.now(); }
          completed.add(s.id);
          pending.delete(s.id);
          this.onRender(`  ⏭ Step: ${s.name} skipped (condition not met)`);
        }
      }

      const ready = workflow.steps.filter((s) => {
        if (!pending.has(s.id)) return false;
        return (s.dependsOn ?? []).every((dep) => completed.has(dep));
      });

      if (ready.length === 0) {
        state.status = "failed";
        return; // Stuck — circular dependency
      }

      // Run ready steps in parallel
      const promises = ready.map(async (step) => {
        const stepState = state.steps.find((ss) => ss.stepId === step.id)!;
        stepState.status = "running";
        stepState.startedAt = Date.now();
        this.onRender(`  ⏳ Step: ${step.name} (parallel)`);

        try {
          const prompt = this.interpolate(step.promptTemplate, state);
          const result = await this.onDelegate(step.agent, prompt, step.tools ?? [], step.budget);
          stepState.status = "completed";
          stepState.result = { summary: result.summary, confidence: result.confidence };
          if (step.outputKey) state.sharedState[step.outputKey] = result.summary;
          state.sharedState[`${step.id}.output.summary`] = result.summary;
          const idx = state.steps.findIndex((ss) => ss.stepId === step.id);
          if (idx >= 0) {
            state.sharedState[`steps[${idx}].output.summary`] = result.summary;
            state.sharedState[`steps[${idx}].output.confidence`] = result.confidence;
          }
          completed.add(step.id);
          pending.delete(step.id);
          this.onRender(`  ✅ Step: ${step.name} complete`);
        } catch (err: any) {
          stepState.status = "failed";
          stepState.error = err.message ?? String(err);
          pending.delete(step.id);
          this.onRender(`  ❌ Step: ${step.name} failed`);
        }
      });

      await Promise.all(promises);
    }

    state.status = completed.size === workflow.steps.length ? "completed" : "failed";
  }

  /**
   * Evaluate a step condition string, e.g. `$steps.step1.confidence == 'high'`.
   * References resolve against shared state (`steps[N].output.*`).
   * Fail-open: missing/unknown references or unparseable expressions → true.
   */
  private evaluateCondition(cond: string, workflow: WorkflowDefinition, state: WorkflowInstanceState): boolean {
    try {
      const m = cond.trim().match(/^(.+?)\s*(==|!=|>=|<=|>|<|contains)\s*(.+)$/);
      if (!m) return true;
      const [, refRaw, op, valRaw] = m;
      const ref = refRaw.trim().replace(/^\$/, "");

      const stepM = ref.match(/^steps\.(.+?)\.(summary|confidence)$/);
      if (stepM) {
        const stepId = stepM[1];
        const field = stepM[2];
        const idx = workflow.steps.findIndex((s) => s.id === stepId);
        if (idx >= 0) {
          const actual = String(state.sharedState[`steps[${idx}].output.${field}`] ?? "");
          const want = valRaw.trim().replace(/^['"]|['"]$/g, "");
          switch (op) {
            case "==": return actual === want;
            case "!=": return actual !== want;
            case "contains": return actual.includes(want);
            case ">": return Number(actual) > Number(want);
            case ">=": return Number(actual) >= Number(want);
            case "<": return Number(actual) < Number(want);
            case "<=": return Number(actual) <= Number(want);
            default: return true;
          }
        }
      }
      return true; // missing ref → pass
    } catch {
      return true; // fail-open
    }
  }

  private interpolate(template: string, state: WorkflowInstanceState): string {
    let result = template;

    // {{input.*}} — parsed command args/flags
    if (state.sharedState.input) {
      const input = state.sharedState.input as ParsedSlashCommand;
      result = result.replace(/\{\{input\.(\w+)\}\}/g, (_, key) => {
        if (key === "target") return (input.flags["target"] as string) ?? input.args[0] ?? "";
        return (input.flags[key] as string) ?? input.args[0] ?? "";
      });
    }

    // {{steps[N].output.*}} — previous step results
    result = result.replace(/\{\{steps\[(\d+)\]\.output\.(\w+)\}\}/g, (_, idx, key) => {
      return String(state.sharedState[`steps[${idx}].output.${key}`] ?? "");
    });

    // {{userFeedback}} — interactive mode input
    result = result.replace(/\{\{userFeedback\}\}/g, state.userFeedback ?? "");

    // {{project.mainLanguage}} etc.
    result = result.replace(/\{\{project\.\w+\}\}/g, "[project context]");

    // {{timestamp}}, {{sessionId}}
    result = result.replace(/\{\{timestamp\}\}/g, new Date().toISOString());
    result = result.replace(/\{\{sessionId\}\}/g, this.sessionId);

    return result;
  }

  private emitWorkflowEvent(event: string, instanceId: string, workflowId: string): void {
    this.bus.emit({
      eventId: randomUUID(),
      type: "STATE_CHANGE",
      timestamp: performance.now(),
      sessionId: this.sessionId,
      causalChainId: randomUUID(),
      payload: {
        previous: "",
        current: `${event}:${workflowId}`,
        reason: `Workflow ${event}`,
        agentId: instanceId,
      },
    } as any);
  }

  private emitStepEvent(step: WorkflowStepState, index: number, total: number): void {
    this.onRender(`  ⏳ Step ${index + 1}/${total}: ${step.name} — ${step.status}`);
  }
}
