// A window's message to the client helper, read as a request before anything acts on it: the
// window is another process, so its message is checked for a request's or a shell input's shape,
// and a request that opens a call or stream under an id its asker holds open is told apart.

import type { ClientHelperWindowRequest } from "#shared/daemon/port-message.js";

/** A window's message read as a request or a shell input, or `undefined` for anything else. */
export function readWindowRequest(data: unknown): ClientHelperWindowRequest | undefined {
  if (data === null || typeof data !== "object") {
    return undefined;
  }
  const message = data as Record<string, unknown>;
  switch (message["kind"]) {
    case "call":
      return isId(message["callId"]) && isRequestBody(message)
        ? (message as ClientHelperWindowRequest)
        : undefined;
    case "stream.open":
      return isId(message["streamId"]) && isRequestBody(message)
        ? (message as ClientHelperWindowRequest)
        : undefined;
    case "call.cancel":
      return isId(message["callId"]) ? (message as ClientHelperWindowRequest) : undefined;
    case "stream.close":
      return isId(message["streamId"]) ? (message as ClientHelperWindowRequest) : undefined;
    case "shell.keys":
      return isShellInput(message, "data") ? (message as ClientHelperWindowRequest) : undefined;
    case "shell.paste":
      return isShellInput(message, "text") ? (message as ClientHelperWindowRequest) : undefined;
    default:
      return undefined;
  }
}

/** The calls and streams one asker holds open, by id. */
interface HeldRequests {
  readonly calls: ReadonlyMap<number, unknown>;
  readonly streams: ReadonlyMap<number, unknown>;
}

/** Whether `request` opens a call or stream under an id its asker already holds open. */
export function isOpenedTwice(held: HeldRequests, request: ClientHelperWindowRequest): boolean {
  switch (request.kind) {
    case "call":
      return held.calls.has(request.callId);
    case "stream.open":
      return held.streams.has(request.streamId);
    default:
      return false;
  }
}

function isId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRequestBody(message: Record<string, unknown>): boolean {
  const attachments = message["attachments"];
  return (
    typeof message["method"] === "string" &&
    Array.isArray(attachments) &&
    attachments.every((attachment) => attachment instanceof Uint8Array)
  );
}

function isShellInput(message: Record<string, unknown>, textMember: "data" | "text"): boolean {
  return (
    typeof message["outputSubscriptionId"] === "string" && typeof message[textMember] === "string"
  );
}
