// Where the composer is addressed, resolved once from the store and the focused pane. Every
// zone calls this hook rather than receiving the answer from the host; the memo over the two
// partitions is a pointer comparison because the store merges immutably.

import { useMemo } from "react";

import { useSessionPartition } from "@renderer/store/session/hooks/useOpenSessionStore.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import type { PaneAddress } from "@renderer/routing/panes/pane-address.js";
import { resolveComposerTarget, type ComposerTarget } from "../composer-target.js";

/** Resolve where the composer is addressed within one session. */
export function useComposerAddress(
  sessionStore: SessionStore,
  focusedPane: PaneAddress | undefined,
): ComposerTarget {
  const agents = useSessionPartition(sessionStore, "agent");
  const runs = useSessionPartition(sessionStore, "run");
  const sessionId = sessionStore.sessionId;
  return useMemo(
    () => resolveComposerTarget({ sessionId, focusedPane, agents, runs }),
    [sessionId, focusedPane, agents, runs],
  );
}
