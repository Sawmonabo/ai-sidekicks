// The one call a pick makes, and the line a refused one reads in the picker. The session exists
// from the pick: its first message is the opened session's own send, so nothing here queues one.

import type { SessionCreateRequest, SessionLead } from "@ai-sidekicks/contracts/session/directory";

import { refusalCause } from "#renderer/lib/code-words.js";
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
 * The line a refused create reads in the picker that asked, its cause the refusal code's words,
 * since the service's sentence for a missing project names it by its id.
 */
export function refusedCreateLine(refusal: ExtendedRefusal): string {
  return `Couldn't start session · ${refusalCause(refusal.code, refusal.reason, refusal.detail)}`;
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
