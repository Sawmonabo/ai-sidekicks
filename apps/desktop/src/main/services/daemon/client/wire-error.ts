// The addon's errors as the helper passes them on: every one is already in the wire's shape.

import type { JsonRpcError } from "@ai-sidekicks/contracts/jsonrpc/message";

/** The addon's error, which is already in the wire's shape, kept to its code, message and data. */
export function wireErrorOf(error: unknown): JsonRpcError {
  const { code, message, data } = error as JsonRpcError;
  return data === undefined ? { code, message } : { code, message, data };
}
