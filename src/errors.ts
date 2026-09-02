/**
 * Bounded, non-private values a client may interpolate into an operator hint.
 * Messages stay internal (the CLI prints codes and fixed lines, never a
 * message), so anything an operator must actually read travels here and is
 * rendered by a client-side hint. Every value is already pattern-bounded at
 * the point it is recorded.
 */
export type BridgeErrorDetail = Readonly<Record<string, string>>;

export class BridgeError extends Error {
  readonly code: string;
  readonly recoverable: boolean;
  readonly detail: BridgeErrorDetail | undefined;

  constructor(code: string, message: string, recoverable = false, detail?: BridgeErrorDetail) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.recoverable = recoverable;
    this.detail = detail;
  }
}
