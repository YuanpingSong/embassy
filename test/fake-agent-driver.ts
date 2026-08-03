import { randomUUID } from "node:crypto";
import type {
  AgentCallbacks,
  AgentDriver,
  AgentProgress,
  AgentRunHandle,
  AgentStartRequest,
  FinalReport,
} from "../src/types.js";

export class FakeRun implements AgentRunHandle {
  readonly request: AgentStartRequest;
  readonly callbacks: AgentCallbacks;
  readonly sessionId: string;
  interruptCount = 0;
  reportUsageOnInterrupt = true;
  private isClosed = false;
  private resolveDone!: () => void;
  readonly done: Promise<void>;

  constructor(request: AgentStartRequest, callbacks: AgentCallbacks) {
    this.request = request;
    this.callbacks = callbacks;
    this.sessionId = request.resumeSessionId ?? randomUUID();
    this.done = new Promise<void>((resolve) => {
      this.resolveDone = resolve;
    });
  }

  get closed(): boolean {
    return this.isClosed;
  }

  async initialize(): Promise<void> {
    await this.callbacks.onSession({
      sessionId: this.sessionId,
      model: this.request.model ?? "fake-claude",
    });
  }

  async progress(progress: AgentProgress): Promise<void> {
    await this.callbacks.onProgress(progress);
  }

  async complete(
    report: FinalReport = {
      outcome: "completed",
      summary: "Fake task completed.",
      changedFiles: [],
      verification: [],
      decisionsNeeded: [],
      warnings: [],
      metrics: { turns: 1 },
    },
  ): Promise<void> {
    await this.callbacks.onResult({
      success: true,
      sessionId: this.sessionId,
      report,
    });
    this.close();
    await this.done;
  }

  async fail(code = "FAKE_FAILURE"): Promise<void> {
    await this.callbacks.onResult({
      success: false,
      sessionId: this.sessionId,
      report: {
        outcome: "failed",
        summary: "Fake task failed.",
        changedFiles: [],
        verification: [],
        decisionsNeeded: [],
        warnings: [],
        metrics: {},
      },
      errorCode: code,
      errorMessage: "Fake task failed.",
    });
    this.close();
    await this.done;
  }

  async interrupt(): Promise<void> {
    this.interruptCount += 1;
    if (this.reportUsageOnInterrupt) {
      await this.callbacks.onResult({
        success: false,
        sessionId: this.sessionId,
        report: {
          outcome: "interrupted",
          summary: "Fake task interrupted.",
          changedFiles: [],
          verification: [],
          decisionsNeeded: [],
          warnings: [],
          metrics: { turns: 1 },
        },
        errorCode: "INTERRUPTED",
        errorMessage: "Fake task interrupted.",
      });
    }
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    void this.callbacks.onClose().finally(() => this.resolveDone());
  }
}

export class FakeAgentDriver implements AgentDriver {
  readonly runs: FakeRun[] = [];

  start(
    request: AgentStartRequest,
    callbacks: AgentCallbacks,
  ): AgentRunHandle {
    const run = new FakeRun(request, callbacks);
    this.runs.push(run);
    return run;
  }

  latest(): FakeRun {
    const run = this.runs.at(-1);
    if (!run) throw new Error("No fake run exists.");
    return run;
  }
}
