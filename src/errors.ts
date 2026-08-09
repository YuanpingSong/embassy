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
