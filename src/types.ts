export const taskStatuses = [
  "queued",
  "running",
  "waiting",
  "completed",
  "blocked",
  "cancelling",
  "interrupted",
  "cancelled",
  "failed",
] as const;

export type TaskStatus = (typeof taskStatuses)[number];

export const permissionProfiles = [
  "read_only",
  "workspace_write",
  "workspace_exec",
] as const;

export type PermissionProfile = (typeof permissionProfiles)[number];

export const networkAccessModes = ["none", "web"] as const;

export type NetworkAccess = (typeof networkAccessModes)[number];

export type TaskEventType =
  | "task_created"
  | "runtime_started"
  | "session_started"
  | "followup_queued"
  | "progress"
  | "tool_started"
  | "tool_progress"
  | "permission_denied"
  | "retrying"
  | "turn_completed"
  | "turn_failed"
  | "interrupt_requested"
  | "task_interrupted"
  | "task_cancelled"
  | "runtime_stopped"
  | "controller_recovered";

export type JsonScalar = string | number | boolean | null;

export type JsonValue =
  | JsonScalar
  | JsonValue[]
  | { [key: string]: JsonValue };

export type TaskEvent = {
  sequence: number;
  timestamp: string;
  type: TaskEventType;
  status: TaskStatus;
  message: string;
  details?: Record<string, JsonValue>;
};

export type ChangedFile = {
  path: string;
  summary: string;
};

export type VerificationItem = {
  name: string;
  status: "passed" | "failed" | "not_run";
  details: string;
};

export type FinalReport = {
  outcome:
    | "completed"
    | "blocked"
    | "failed"
    | "interrupted"
    | "cancelled";
  summary: string;
  changedFiles: ChangedFile[];
  verification: VerificationItem[];
  decisionsNeeded: string[];
  warnings: string[];
  metrics: {
    durationMs?: number;
    turns?: number;
    stopReason?: string;
    permissionDenials?: number;
  };
};

export type TaskRecord = {
  schemaVersion: 2;
  backend: "local_claude_code";
  taskId: string;
  title: string;
  cwd: string;
  requestedModel?: string;
  activeModel?: string;
  permissionProfile: PermissionProfile;
  networkAccess: NetworkAccess;
  maxTurns: number;
  turnsUsed: number;
  usageAccountingComplete: boolean;
  processExitConfirmed: boolean;
  status: TaskStatus;
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  turnsQueued: number;
  turnsCompleted: number;
  turnsAbandoned: number;
  eventSequence: number;
  events: TaskEvent[];
  finalReport?: FinalReport;
  lastError?: {
    code: string;
    message: string;
    recoverable: boolean;
  };
};

export type TaskSnapshot = Omit<TaskRecord, "events" | "sessionId"> & {
  sessionEstablished: boolean;
  canFollowUp: boolean;
  isActive: boolean;
  latestEvents: TaskEvent[];
};

export type StartTaskInput = {
  prompt: string;
  cwd: string;
  title?: string;
  model?: string;
  permissionProfile?: PermissionProfile;
  networkAccess?: NetworkAccess;
  maxTurns?: number;
};

export type FollowupInput = {
  taskId: string;
  prompt: string;
};

export type WaitInput = {
  taskId: string;
  afterSequence: number;
  timeoutMs: number;
  limit: number;
  signal?: AbortSignal;
};

export type WaitResult = {
  task: TaskSnapshot;
  events: TaskEvent[];
  nextSequence: number;
  timedOut: boolean;
  terminal: boolean;
  historyTruncated: boolean;
};

export type AgentProgress = {
  kind:
    | "assistant"
    | "tool_started"
    | "tool_progress"
    | "status"
    | "permission_denied"
    | "retrying"
    | "session_state";
  message: string;
  status?: "running" | "waiting";
  details?: Record<string, JsonValue>;
};

export type AgentTurnResult = {
  success: boolean;
  sessionId: string;
  report: FinalReport;
  errorCode?: string;
  errorMessage?: string;
};

export type AgentStartRequest = {
  taskId: string;
  title: string;
  initialPrompt: string;
  cwd: string;
  resumeSessionId?: string;
  model?: string;
  permissionProfile: PermissionProfile;
  networkAccess: NetworkAccess;
  maxTurns: number;
  stateDir: string;
  tempDir: string;
  profileDir: string;
  execEnabled: boolean;
  webEnabled: boolean;
};

export type AgentCallbacks = {
  onSession: (session: {
    sessionId: string;
    model: string;
  }) => Promise<void>;
  onProgress: (progress: AgentProgress) => Promise<void>;
  onResult: (result: AgentTurnResult) => Promise<void>;
  onError: (error: {
    code: string;
    message: string;
    recoverable: boolean;
  }) => Promise<void>;
  onClose: () => Promise<void>;
};

export type AgentRunHandle = {
  interrupt: () => Promise<void>;
  close: () => void;
  readonly done: Promise<void>;
  readonly closed: boolean;
};

export interface AgentDriver {
  start(request: AgentStartRequest, callbacks: AgentCallbacks): AgentRunHandle;
}

export const terminalStatuses = new Set<TaskStatus>([
  "completed",
  "blocked",
  "interrupted",
  "cancelled",
  "failed",
]);

export function isTerminalStatus(status: TaskStatus): boolean {
  return terminalStatuses.has(status);
}
