// A session's shells as the pane reads them, kept current off the shell list for the session on
// screen. Opening the pane reads the shells the session really has, and a fresh shell is opened
// only when the session has none, once per visit, so a list restated empty later opens nothing.

import { useEffect } from "react";

import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { TerminalListEntry } from "@ai-sidekicks/contracts/terminal";

import { useSubjectScopedState } from "#renderer/hooks/subject-scoped/useSubjectScopedState.js";
import type { Refusal } from "#renderer/lib/refusal/contract.js";
import { callDaemon } from "#renderer/services/daemon/reply.js";
import { followShellList } from "#renderer/services/daemon/terminal/list.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";

/** The session's shells in tab order, `undefined` until the list is read, and why it cannot be. */
export interface SessionShells {
  readonly terminals: readonly TerminalListEntry[] | undefined;
  /** Why the list could not be opened again, or a fresh shell could not be opened. */
  readonly refusal: Refusal | undefined;
}

const UNREAD_SESSION_SHELLS: SessionShells = { terminals: undefined, refusal: undefined };

/** Follow the session's shells while the pane shows it, opening one when it has none. */
export function useSessionShells(bridge: PlatformBridge, sessionId: SessionId): SessionShells {
  const { value, publish } = useSubjectScopedState(bridge, sessionId, () => UNREAD_SESSION_SHELLS);

  useEffect(() => {
    let isOpenAsked = false;
    return followShellList(bridge, sessionId, (frame) => {
      if (frame.kind === "reopenRefusal") {
        publish((current) => ({ ...current, refusal: frame.refusal }));
        return;
      }
      publish((current) => ({ ...current, terminals: frame.terminals }));
      if (frame.terminals.length > 0 || isOpenAsked) {
        return;
      }
      isOpenAsked = true;
      // The new shell arrives on the list; only a refusal is read off the reply.
      void callDaemon(bridge, "terminal.open", {
        sessionId,
        clientIdempotencyKey: crypto.randomUUID(),
      }).then((reply) => {
        if (reply.status === "refused") {
          publish((current) => ({ ...current, refusal: reply.refusal }));
        }
      });
    });
  }, [bridge, publish, sessionId]);

  return value;
}
