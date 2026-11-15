// The one call a pick makes, the name a pick's create keeps its key under, and the line a refused
// one reads in the picker. The session exists from the pick: its first message is the opened
// session's own send, so nothing here queues one.

import type { SessionCreateRequest, SessionLead } from "@ai-sidekicks/contracts/session/directory";

import { refusalCause } from "#renderer/lib/code-words.js";
import type { Refusal } from "#renderer/lib/refusal/contract.js";
import type { ExtendedRefusal } from "#renderer/lib/refusal/extensions.js";
import { callDaemon, type DaemonReply } from "#renderer/services/daemon/reply.js";
import type { DaemonResult } from "#shared/daemon/method-bindings.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import type { NewSessionProject } from "./control-contract.js";

/** One pick: where the session works, its lead, and the key that names the create. */
export interface NewSessionPickRequest {
  /** The picked project; absent, the pick was `Just chat`. */
  readonly project: NewSessionProject | undefined;
  readonly lead: SessionLead;
  /** The create's key: sent again for the same row, the service answers with the session made. */
  readonly clientIdempotencyKey: string;
}

/** Create the picked session. Never throws: a refused or unreadable create is the refusal arm. */
export async function createPickedSession(
  bridge: PlatformBridge,
  pick: NewSessionPickRequest,
): Promise<DaemonReply<DaemonResult<"session.create">>> {
  return await callDaemon(bridge, "session.create", sessionCreateRequest(pick));
}

/**
 * One row's create on one lead, named by every member the request sends but its key, each object's
 * members in name order: a changed speed or option names another create, and a member the request
 * gains is in the name at once.
 */
export function createIdentityOf(
  project: NewSessionProject | undefined,
  lead: SessionLead,
): string {
  const { clientIdempotencyKey: _unsent, ...sent } = sessionCreateRequest({
    project,
    lead,
    clientIdempotencyKey: "",
  });
  return JSON.stringify(sent, inNameOrder);
}

/**
 * The line a refused create reads in the picker that asked, its cause the refusal code's words,
 * since the service's sentence for a missing project names it by its id. The line carries the
 * app's own code, so it is drawn as worded.
 */
export function refusedCreateLine(refusal: ExtendedRefusal): Pick<Refusal, "code" | "detail"> {
  return {
    code: REFUSED_CREATE_CODE,
    detail: `Couldn't start session · ${refusalCause(refusal.code, refusal.reason, refusal.detail)}`,
  };
}

/** The create, bound where the session works: the picked project, or a chat. */
function sessionCreateRequest(pick: NewSessionPickRequest): SessionCreateRequest {
  const { clientIdempotencyKey, lead, project } = pick;
  return project === undefined
    ? { clientIdempotencyKey, lead, binding: { kind: "chat" } }
    : {
        clientIdempotencyKey,
        lead,
        binding: {
          kind: "project",
          projectId: project.projectId,
          executionMode: project.executionMode,
        },
      };
}

// An object's members in name order, so one request reads as one text however it was built.
function inNameOrder(_name: string, value: unknown): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
          left < right ? -1 : 1,
        ),
      )
    : value;
}

/** The code of the picker's line for a refused create, which the app words. */
const REFUSED_CREATE_CODE = "session-start-refused";
