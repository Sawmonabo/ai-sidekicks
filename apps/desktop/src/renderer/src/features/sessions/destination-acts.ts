// What the destination's acts do, bound to one screen context. Kept apart from
// `SessionsFlyout.tsx`, which says what is drawn: nothing here renders, so a suite can drive an
// act without mounting a screen.
//
// Opening a session from a row, from an attention item, and after a start are the same
// navigation, declared once so views cannot drift on where a press goes. Opening an attention
// item resolves nothing: resolution lives in the daemon, and a client-side dismiss would be a
// heuristic standing in for it.

import type { ScreenContext } from "#renderer/registries/screens/context.js";
import type { AttentionItem } from "@ai-sidekicks/contracts/attention";
import { settleSessionStart } from "./start.js";

/** Every act the sessions destination performs, already bound to its context. */
export interface SessionDestinationActs {
  readonly openSession: (sessionId: string) => void;
  readonly openAttentionItem: (item: AttentionItem) => void;
  /** What a session started here settles into, for both ways of starting one. */
  readonly settleStartedSession: (sessionId: string) => void;
  /** Declares the daemon's directory stale, so this destination's list re-reads it. */
  readonly recheckSessionDirectory: () => void;
}

/**
 * Binds the destination's acts to one screen context. A plain function, not a hook: the acts
 * capture the context and take the session as an argument, so none holds a session id.
 */
export function sessionDestinationActs(
  context: ScreenContext,
  recheckDirectory: () => void,
): SessionDestinationActs {
  const openSession = (sessionId: string): void => {
    context.frameStore.navigate({ kind: "session", sessionId });
  };
  return {
    openSession,
    openAttentionItem: (item) => {
      openSession(item.sessionId);
    },
    // `start.ts` holds the three steps that follow a session this window started.
    settleStartedSession: (sessionId) => {
      settleSessionStart({
        sessionStoreRegistry: context.sessionStoreRegistry,
        openSession,
        recheckDirectory,
        sessionId,
      });
    },
    // After a create whose reply could not be read, the session may exist under an id nothing
    // in this window holds; the directory read is what would name it.
    recheckSessionDirectory: recheckDirectory,
  };
}
