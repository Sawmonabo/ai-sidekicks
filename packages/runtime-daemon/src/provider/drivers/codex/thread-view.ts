/** Reads a Codex thread, its turns and its turn ids as the client returns them. */

import { isPlainObject } from "../../record-readers.js";
import { CodexTransportError } from "./session-errors.js";

interface ThreadView {
  id: string;
  sessionId: string;
  turns: unknown;
}

/** Reads the thread from a thread response, throwing a transport error when it carries none. */
export function readThread(response: unknown, method: string): ThreadView {
  const record = isPlainObject(response) ? response : {};
  const thread = record["thread"];
  // The shared guard also refuses an array, whose `["id"]` would read `undefined`.
  if (!isPlainObject(thread)) {
    throw new CodexTransportError(`The Codex app-server "${method}" response carried no thread.`, {
      method,
    });
  }
  const id = thread["id"];
  const sessionId = thread["sessionId"];
  if (typeof id !== "string" || id.length === 0 || typeof sessionId !== "string") {
    throw new CodexTransportError(
      `The Codex app-server "${method}" response carried an unusable thread identity.`,
      { method },
    );
  }
  return { id, sessionId, turns: thread["turns"] };
}

/**
 * Reads the network access a thread reply's realized `sandbox` carries, which reflects the person's
 * own Codex config; `undefined` when the policy has no boolean member (Full Access has none).
 */
export function readThreadNetworkAccess(response: unknown): boolean | undefined {
  const record = isPlainObject(response) ? response : {};
  const sandbox = record["sandbox"];
  const networkAccess = isPlainObject(sandbox) ? sandbox["networkAccess"] : undefined;
  return typeof networkAccess === "boolean" ? networkAccess : undefined;
}

/**
 * Reads the ordered turn ids out of a `Thread.turns` array. Total, not throwing: the list is a
 * bookkeeping seed. Non-string and empty entries are skipped, since a placeholder would shift
 * every later ordinal onto the wrong turn.
 */
export function readThreadTurnIds(turns: unknown): string[] {
  if (!Array.isArray(turns)) {
    return [];
  }
  const turnIds: string[] = [];
  for (const turn of turns) {
    const id = isPlainObject(turn) ? turn["id"] : undefined;
    if (typeof id === "string" && id.length > 0) {
      turnIds.push(id);
    }
  }
  return turnIds;
}

/**
 * Reads the turn a `turn/steer` acknowledgement named, or `null`. Total, unlike `readTurnId`: an
 * unreadable ack is an acknowledgement with no evidence, graded degraded, not a transport fault.
 * It is the flat `{ turnId }`, not `turn/start`'s `{ turn: { id } }`.
 */
export function readSteeredTurnId(response: unknown): string | null {
  const record = isPlainObject(response) ? response : {};
  const turnId = record["turnId"];
  return typeof turnId === "string" && turnId.length > 0 ? turnId : null;
}

/** Reads the turn id from a turn response, throwing a transport error when it carries none. */
export function readTurnId(response: unknown, method: string): string {
  const record = isPlainObject(response) ? response : {};
  const turn = record["turn"];
  const turnRecord = isPlainObject(turn) ? turn : {};
  const id = turnRecord["id"];
  if (typeof id !== "string" || id.length === 0) {
    throw new CodexTransportError(`The Codex app-server "${method}" response carried no turn id.`, {
      method,
    });
  }
  return id;
}
