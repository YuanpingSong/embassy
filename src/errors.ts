export class BridgeError extends Error {
  readonly code: string;
  readonly recoverable: boolean;

  constructor(code: string, message: string, recoverable = false) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.recoverable = recoverable;
  }
}

export function safeError(error: unknown): {
  code: string;
  message: string;
  recoverable: boolean;
} {
  if (error instanceof BridgeError) {
    return {
      code: error.code,
      message: error.message,
      recoverable: error.recoverable,
    };
  }

  return {
    code: "INTERNAL_ERROR",
    message:
      "The Claude task controller encountered an internal error. Check the bridge's stderr logs.",
    recoverable: false,
  };
}
