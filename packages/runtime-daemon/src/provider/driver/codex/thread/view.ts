/** Reads a Codex thread, its turns and its turn ids as the client returns them. */

import { isPlainObject } from "../../../record-readers.js";
import { composeCodexProfileName } from "../permission-level.js";
import { CodexTransportError } from "../session/errors.js";
import type { CodexThreadSettings } from "./settings.js";

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

/** The reasoning effort a start, resume or fork reply names, or `null` for none. */
export function readThreadReasoningEffort(response: unknown): string | null {
  const effort = isPlainObject(response) ? response["reasoningEffort"] : undefined;
  return typeof effort === "string" && effort.length > 0 ? effort : null;
}

/**
 * Checks that a start, resume or fork reply names the permission profile the thread asked for.
 * Throws `CodexTransportError` when it names none or another: a conversation must never run
 * without the level it was given.
 */
export function assertActivePermissionProfile(
  response: unknown,
  requestedProfile: string,
  method: string,
): void {
  const record = isPlainObject(response) ? response : {};
  const active = record["activePermissionProfile"];
  const activeId = isPlainObject(active) ? active["id"] : undefined;
  if (activeId !== requestedProfile) {
    throw new CodexTransportError(
      `The Codex app-server "${method}" reply did not run the conversation under the ` +
        `permission profile it was given.`,
      {
        method,
        requestedProfile,
        activeProfile: typeof activeId === "string" ? activeId : "none",
      },
    );
  }
}

/**
 * Checks that a start, resume or fork reply runs the conversation under the profile its settings'
 * level selects. Throws as {@link assertActivePermissionProfile} does.
 */
export function assertCodexThreadProfile(
  response: unknown,
  settings: CodexThreadSettings,
  method: string,
): void {
  assertActivePermissionProfile(
    response,
    composeCodexProfileName(settings.level, settings.profileFolders),
    method,
  );
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
