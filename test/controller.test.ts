import assert from "node:assert/strict";
import { mkdir, rename, symlink } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { BridgeError } from "../src/errors.js";
import { TaskController } from "../src/task-controller.js";
import { TaskStore } from "../src/task-store.js";
import { FakeAgentDriver } from "./fake-agent-driver.js";
import { createHarness } from "./test-harness.js";

test("start, observe, follow up in the same session, and collect result", async () => {
  const harness = await createHarness();
  const started = await harness.controller.startTask({
    prompt: "Inspect the workspace.",
    cwd: harness.workspace,
    title: "inspection",
  });

  assert.equal(started.status, "running");
  assert.equal(started.permissionProfile, "read_only");
  assert.equal(started.sessionEstablished, false);
  assert.equal(harness.driver.runs.length, 1);

  const run = harness.driver.latest();
  await run.initialize();
  assert.equal(
    (await harness.controller.getTask(started.taskId)).canFollowUp,
    false,
  );
  await run.progress({
    kind: "tool_started",
    message: "Claude started Read.",
    status: "running",
    details: { toolName: "Read" },
  });
  await run.complete({
    outcome: "completed",
    summary: "The workspace is healthy.",
    changedFiles: [],
    verification: [
      {
        name: "inspection",
        status: "passed",
        details: "Read-only inspection completed.",
      },
    ],
    decisionsNeeded: [],
    warnings: [],
    metrics: { turns: 1 },
  });

  const completed = await harness.controller.getTask(started.taskId);
  assert.equal(completed.status, "completed");
  assert.equal(completed.finalReport?.summary, "The workspace is healthy.");
  assert.equal(completed.canFollowUp, true);
  const sessionId = (await harness.store.load(started.taskId)).sessionId;
  assert.ok(sessionId);

  const followed = await harness.controller.followup({
    taskId: started.taskId,
    prompt: "Now summarize the entry points.",
  });
  assert.equal(followed.status, "queued");
  assert.equal(followed.finalReport, undefined);
  assert.equal(harness.driver.runs.length, 2);

  const resumedRun = harness.driver.latest();
  assert.equal(resumedRun.request.resumeSessionId, sessionId);
  assert.equal(resumedRun.request.maxTurns, 19);
  await resumedRun.initialize();
  await resumedRun.complete({
    outcome: "completed",
    summary: "Entry points summarized.",
    changedFiles: [],
    verification: [],
    decisionsNeeded: [],
    warnings: [],
    metrics: { turns: 1 },
  });
  const final = await harness.controller.getTask(started.taskId);
  assert.equal(final.status, "completed");
  assert.equal(
    (await harness.store.load(started.taskId)).sessionId,
    sessionId,
  );
  assert.equal(final.turnsQueued, 2);
  assert.equal(final.turnsCompleted, 2);
  assert.equal(final.turnsAbandoned, 0);
  assert.equal(final.turnsUsed, 2);
  assert.equal(final.usageAccountingComplete, true);
  assert.equal(final.finalReport?.summary, "Entry points summarized.");

  await harness.controller.shutdown();
});

test("wait returns cursor-based events and cancelling a wait leaves task running", async () => {
  const harness = await createHarness();
  const task = await harness.controller.startTask({
    prompt: "Wait for a signal.",
    cwd: harness.workspace,
  });
  const cursor = task.eventSequence;

  const waitPromise = harness.controller.wait({
    taskId: task.taskId,
    afterSequence: cursor,
    timeoutMs: 1_000,
    limit: 20,
  });
  await harness.driver.latest().initialize();
  const update = await waitPromise;
  assert.equal(update.timedOut, false);
  assert.ok(update.events.some((event) => event.type === "session_started"));

  const latest = await harness.controller.getTask(task.taskId);
  const abort = new AbortController();
  const cancelledWait = harness.controller.wait({
    taskId: task.taskId,
    afterSequence: latest.eventSequence,
    timeoutMs: 1_000,
    limit: 20,
    signal: abort.signal,
  });
  abort.abort();
  await assert.rejects(cancelledWait, (error: unknown) => {
    return error instanceof BridgeError && error.code === "WAIT_CANCELLED";
  });
  assert.equal(
    (await harness.controller.getTask(task.taskId)).status,
    "running",
  );

  await harness.controller.shutdown();
});

test("interrupt is resumable while cancel permanently closes the task", async () => {
  const harness = await createHarness();
  const started = await harness.controller.startTask({
    prompt: "Begin a long task.",
    cwd: harness.workspace,
  });
  const firstRun = harness.driver.latest();
  await firstRun.initialize();
  const sessionId = firstRun.sessionId;

  const interrupted = await harness.controller.interrupt(
    started.taskId,
    "interrupt",
  );
  assert.equal(interrupted.requested, true);
  assert.equal(interrupted.task.status, "interrupted");
  assert.equal(interrupted.task.canFollowUp, true);
  assert.equal(firstRun.interruptCount, 1);

  await harness.controller.followup({
    taskId: started.taskId,
    prompt: "Resume carefully.",
  });
  const secondRun = harness.driver.latest();
  assert.notEqual(secondRun, firstRun);
  assert.equal(secondRun.request.resumeSessionId, sessionId);
  await secondRun.initialize();
  await secondRun.complete();
  const resumed = await harness.controller.getTask(started.taskId);
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.turnsQueued, 2);
  assert.equal(resumed.turnsCompleted, 1);
  assert.equal(resumed.turnsAbandoned, 1);

  const cancelled = await harness.controller.interrupt(
    started.taskId,
    "cancel",
  );
  assert.equal(cancelled.task.status, "cancelled");
  assert.equal(cancelled.task.canFollowUp, false);
  await assert.rejects(
    harness.controller.followup({
      taskId: started.taskId,
      prompt: "This must be rejected.",
    }),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "TASK_CANCELLED",
  );
  await harness.controller.shutdown();
});

test("blocked reports are terminal and remain resumable", async () => {
  const harness = await createHarness();
  const started = await harness.controller.startTask({
    prompt: "Find the missing decision.",
    cwd: harness.workspace,
  });
  const run = harness.driver.latest();
  await run.initialize();
  await run.complete({
    outcome: "blocked",
    summary: "A user decision is required.",
    changedFiles: [],
    verification: [],
    decisionsNeeded: ["Choose the deployment target."],
    warnings: [],
    metrics: { turns: 1 },
  });

  const blocked = await harness.controller.getTask(started.taskId);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.canFollowUp, true);
  const waited = await harness.controller.wait({
    taskId: started.taskId,
    afterSequence: blocked.eventSequence,
    timeoutMs: 1_000,
    limit: 20,
  });
  assert.equal(waited.terminal, true);
  assert.equal(waited.timedOut, false);
  await harness.controller.shutdown();
});

test("a terminal failed result releases its runtime capacity", async () => {
  const harness = await createHarness();
  harness.config.maxConcurrentTasks = 1;
  harness.config.idleRuntimeMs = 5;
  const started = await harness.controller.startTask({
    prompt: "Return a structured failure.",
    cwd: harness.workspace,
  });
  const run = harness.driver.latest();
  await run.initialize();
  await run.complete({
    outcome: "failed",
    summary: "The requested work could not be completed.",
    changedFiles: [],
    verification: [],
    decisionsNeeded: [],
    warnings: [],
    metrics: { turns: 1 },
  });

  assert.equal(
    (await harness.controller.getTask(started.taskId)).status,
    "failed",
  );
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 25);
  });
  assert.equal(run.closed, true);
  const next = await harness.controller.startTask({
    prompt: "Use the released capacity.",
    cwd: harness.workspace,
  });
  assert.equal(next.status, "running");
  await harness.controller.shutdown();
});

test("cumulative CLI turn limits cannot be reset by a resumed follow-up", async () => {
  const harness = await createHarness();
  const started = await harness.controller.startTask({
    prompt: "Use the single allowed CLI turn.",
    cwd: harness.workspace,
    maxTurns: 1,
  });
  const run = harness.driver.latest();
  await run.initialize();
  await run.complete({
    outcome: "completed",
    summary: "Allowance consumed.",
    changedFiles: [],
    verification: [],
    decisionsNeeded: [],
    warnings: [],
    metrics: { turns: 1 },
  });

  assert.equal(
    (await harness.controller.getTask(started.taskId)).canFollowUp,
    false,
  );
  await assert.rejects(
    harness.controller.followup({
      taskId: started.taskId,
      prompt: "This must not receive a fresh query allowance.",
    }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "TASK_LIMIT_EXHAUSTED",
  );
  assert.equal(harness.driver.runs.length, 1);
  const task = await harness.controller.getTask(started.taskId);
  assert.equal(task.status, "completed");
  assert.equal(task.canFollowUp, false);
  await harness.controller.shutdown();
});

test("missing interrupt usage fails closed against another allowance", async () => {
  const harness = await createHarness();
  const started = await harness.controller.startTask({
    prompt: "Interrupt without a result.",
    cwd: harness.workspace,
    maxTurns: 2,
  });
  const run = harness.driver.latest();
  run.reportUsageOnInterrupt = false;
  await run.initialize();
  const interrupted = await harness.controller.interrupt(
    started.taskId,
    "interrupt",
  );
  assert.equal(interrupted.task.status, "interrupted");
  assert.equal(interrupted.task.usageAccountingComplete, false);
  assert.equal(interrupted.task.canFollowUp, false);
  await assert.rejects(
    harness.controller.followup({
      taskId: started.taskId,
      prompt: "Do not reset the unknown allowance.",
    }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "USAGE_ACCOUNTING_INCOMPLETE",
  );
  assert.equal(harness.driver.runs.length, 1);
  await harness.controller.shutdown();
});

test("a runtime that closes without a result is not resumable", async () => {
  const harness = await createHarness();
  const started = await harness.controller.startTask({
    prompt: "Exit without a result.",
    cwd: harness.workspace,
  });
  const run = harness.driver.latest();
  await run.initialize();
  run.close();
  await run.done;

  const failed = await harness.controller.getTask(started.taskId);
  assert.equal(failed.status, "failed");
  assert.equal(failed.lastError?.code, "MISSING_RESULT");
  assert.equal(failed.usageAccountingComplete, false);
  assert.equal(failed.canFollowUp, false);
  await assert.rejects(
    harness.controller.followup({
      taskId: started.taskId,
      prompt: "Must not receive another allowance.",
    }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "USAGE_ACCOUNTING_INCOMPLETE",
  );
  await harness.controller.shutdown();
});

test("concurrent follow-ups start one runtime and reject the other", async () => {
  const harness = await createHarness();
  const started = await harness.controller.startTask({
    prompt: "Complete the first instruction.",
    cwd: harness.workspace,
  });
  const first = harness.driver.latest();
  await first.initialize();
  await first.complete();

  const outcomes = await Promise.allSettled([
    harness.controller.followup({
      taskId: started.taskId,
      prompt: "Follow-up A.",
    }),
    harness.controller.followup({
      taskId: started.taskId,
      prompt: "Follow-up B.",
    }),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
  const rejection = outcomes.find(
    (outcome): outcome is PromiseRejectedResult =>
      outcome.status === "rejected",
  );
  assert.ok(rejection?.reason instanceof BridgeError);
  assert.equal(rejection.reason.code, "TASK_BUSY");
  assert.equal(harness.driver.runs.length, 2);
  await harness.controller.shutdown();
});

test("cancel dominates concurrent interruption and fences late callbacks", async () => {
  const harness = await createHarness();
  const started = await harness.controller.startTask({
    prompt: "Remain active.",
    cwd: harness.workspace,
  });
  const run = harness.driver.latest();
  await run.initialize();

  await Promise.all([
    harness.controller.interrupt(started.taskId, "interrupt"),
    harness.controller.interrupt(started.taskId, "cancel"),
  ]);
  assert.equal(
    (await harness.controller.getTask(started.taskId)).status,
    "cancelled",
  );

  await run.initialize();
  await run.complete();
  const afterLateCallbacks = await harness.controller.getTask(started.taskId);
  assert.equal(afterLateCallbacks.status, "cancelled");
  assert.equal(afterLateCallbacks.canFollowUp, false);
  await harness.controller.shutdown();
});

test("controller recovery marks active work interrupted without replay", async () => {
  const harness = await createHarness();
  const started = await harness.controller.startTask({
    prompt: "Potentially effectful work.",
    cwd: harness.workspace,
    permissionProfile: "workspace_write",
  });
  await harness.driver.latest().initialize();

  // Simulate process death: the old process would no longer hold the state
  // lock or run callbacks, while its last persisted status remains active.
  await harness.store.releaseControllerLock();
  const replacementDriver = new FakeAgentDriver();
  const replacement = new TaskController(
    harness.config,
    new TaskStore(harness.stateDir),
    replacementDriver,
  );
  await replacement.initialize();

  const recovered = await replacement.getTask(started.taskId);
  assert.equal(recovered.status, "interrupted");
  assert.equal(recovered.lastError?.code, "CONTROLLER_RESTART");
  assert.equal(replacementDriver.runs.length, 0);
  assert.equal(recovered.canFollowUp, false);
  assert.equal(recovered.usageAccountingComplete, false);
  assert.equal(recovered.processExitConfirmed, false);
  await assert.rejects(
    replacement.startTask({
      prompt: "Do not overlap an unconfirmed prior process.",
      cwd: harness.workspace,
    }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "RUNTIME_EXIT_UNCONFIRMED",
  );
  await replacement.shutdown();
  await harness.controller.shutdown();
});

test("workspace and capability policies fail closed", async () => {
  const harness = await createHarness();
  harness.config.writeEnabled = false;
  await assert.rejects(
    harness.controller.startTask({
      prompt: "   ",
      cwd: harness.workspace,
    }),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "EMPTY_PROMPT",
  );
  await assert.rejects(
    harness.controller.startTask({
      prompt: "Use an invalid allowance.",
      cwd: harness.workspace,
      maxTurns: Number.NaN,
    }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "INVALID_TASK_LIMIT",
  );
  await assert.rejects(
    harness.controller.startTask({
      prompt: "Use an option-like model.",
      cwd: harness.workspace,
      model: "--dangerously-skip-permissions",
    }),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "INVALID_MODEL",
  );
  await assert.rejects(
    harness.controller.startTask({
      prompt: "Read outside the grant.",
      cwd: harness.root,
    }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "WORKSPACE_NOT_ALLOWED",
  );

  await assert.rejects(
    harness.controller.startTask({
      prompt: "Write files.",
      cwd: harness.workspace,
      permissionProfile: "workspace_write",
    }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "WORKSPACE_WRITE_DISABLED",
  );

  await assert.rejects(
    harness.controller.startTask({
      prompt: "Run commands.",
      cwd: harness.workspace,
      permissionProfile: "workspace_exec",
    }),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "EXECUTION_DISABLED",
  );

  await assert.rejects(
    harness.controller.startTask({
      prompt: "Browse the web.",
      cwd: harness.workspace,
      networkAccess: "web",
    }),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "WEB_ACCESS_DISABLED",
  );
  await harness.controller.shutdown();
});

test("configured default model is used unless a task overrides it", async () => {
  const harness = await createHarness();
  harness.config.defaultModel = "fable";
  const defaulted = await harness.controller.startTask({
    prompt: "Use the configured model.",
    cwd: harness.workspace,
  });
  assert.equal(harness.driver.latest().request.model, "fable");
  await harness.driver.latest().initialize();
  await harness.driver.latest().complete();

  const overridden = await harness.controller.startTask({
    prompt: "Use the explicit model.",
    cwd: harness.workspace,
    model: "opus",
  });
  assert.equal(harness.driver.latest().request.model, "opus");
  assert.notEqual(overridden.taskId, defaulted.taskId);
  await harness.controller.shutdown();
});

test("follow-up rechecks the current write policy", async () => {
  const harness = await createHarness();
  const started = await harness.controller.startTask({
    prompt: "Complete one writable turn.",
    cwd: harness.workspace,
    permissionProfile: "workspace_write",
  });
  await harness.driver.latest().initialize();
  await harness.driver.latest().complete();

  harness.config.writeEnabled = false;
  await assert.rejects(
    harness.controller.followup({
      taskId: started.taskId,
      prompt: "Do not resume after the policy was disabled.",
    }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "WORKSPACE_WRITE_DISABLED",
  );
  assert.equal(harness.driver.runs.length, 1);
  const task = await harness.controller.getTask(started.taskId);
  assert.equal(task.status, "completed");
  assert.equal(task.canFollowUp, false);
  await harness.controller.shutdown();
});

test("parent and child workspace leases conflict when either task can write", async () => {
  const first = await createHarness();
  const firstChild = path.join(first.workspace, "nested");
  await mkdir(firstChild);
  await first.controller.startTask({
    prompt: "Read the parent.",
    cwd: first.workspace,
  });
  await assert.rejects(
    first.controller.startTask({
      prompt: "Write in the child.",
      cwd: firstChild,
      permissionProfile: "workspace_write",
    }),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "WORKSPACE_BUSY",
  );
  await first.controller.shutdown();

  const second = await createHarness();
  const secondChild = path.join(second.workspace, "nested");
  await mkdir(secondChild);
  await second.controller.startTask({
    prompt: "Write in the child.",
    cwd: secondChild,
    permissionProfile: "workspace_write",
  });
  await assert.rejects(
    second.controller.startTask({
      prompt: "Read the parent.",
      cwd: second.workspace,
    }),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "WORKSPACE_BUSY",
  );
  await second.controller.shutdown();
});

test("follow-up rejects a workspace removed from the current grant", async () => {
  const harness = await createHarness();
  const started = await harness.controller.startTask({
    prompt: "Complete under the original grant.",
    cwd: harness.workspace,
  });
  const run = harness.driver.latest();
  await run.initialize();
  await run.complete();
  run.close();
  await run.done;
  await harness.store.releaseControllerLock();

  const replacementWorkspace = path.join(harness.root, "replacement");
  await mkdir(replacementWorkspace);
  const replacementDriver = new FakeAgentDriver();
  const replacement = new TaskController(
    {
      ...harness.config,
      allowedWorkspaceRoots: [replacementWorkspace],
    },
    new TaskStore(harness.stateDir),
    replacementDriver,
  );
  await replacement.initialize();
  await assert.rejects(
    replacement.followup({
      taskId: started.taskId,
      prompt: "Do not use the revoked directory.",
    }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "WORKSPACE_NOT_ALLOWED",
  );
  assert.equal(replacementDriver.runs.length, 0);
  await replacement.shutdown();
  await harness.controller.shutdown();
});

test("follow-up rejects a persisted cwd replaced by a symlink", async () => {
  const harness = await createHarness();
  const original = path.join(harness.workspace, "original");
  const moved = path.join(harness.workspace, "moved");
  const outside = path.join(harness.root, "outside");
  await Promise.all([mkdir(original), mkdir(outside)]);
  const started = await harness.controller.startTask({
    prompt: "Complete in the original directory.",
    cwd: original,
  });
  const run = harness.driver.latest();
  await run.initialize();
  await run.complete();
  run.close();
  await run.done;

  await rename(original, moved);
  await symlink(outside, original);
  await assert.rejects(
    harness.controller.followup({
      taskId: started.taskId,
      prompt: "Do not follow the replacement symlink.",
    }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "WORKSPACE_NOT_ALLOWED",
  );
  assert.equal(harness.driver.runs.length, 1);
  await harness.controller.shutdown();
});
