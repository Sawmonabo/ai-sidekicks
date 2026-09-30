// Session-domain error surface for IPC handlers.

/**
 * Thrown when a supplied `sessionId` does not resolve to a known session, for example by
 * `SessionReadDeps.readSession`. `mapJsonRpcError` maps it to `-32602` (the id is a bad
 * parameter) with `data.type` set to the `code` and `data.fields` set to `fields` (the offending
 * `sessionId`). A plain `Error` would collapse to `-32603`.
 */
export class SessionNotFoundError extends Error {
  readonly code = "session.not_found" as const;
  readonly fields?: Record<string, unknown>;

  constructor(message: string, fields?: Record<string, unknown>) {
    super(message);
    this.name = "SessionNotFoundError";
    if (fields !== undefined) {
      this.fields = fields;
    }
  }
}
