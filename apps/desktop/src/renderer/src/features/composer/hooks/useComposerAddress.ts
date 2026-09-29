// Where the composer is addressed, resolved once from the store and the focused pane.
//
// A hook rather than a derivation in a render body, per this package's structure
// rules: the resolution reads two store partitions, and a component that read them
// inline would re-derive on every render of every zone that needed the answer.
// `useMemo` over the two partition references is exact — the store merges
// immutably, so an untouched partition keeps its identity and the memo is a pointer
// comparison rather than a deep one.
//
// EVERY ZONE THAT NEEDS THE ADDRESS CALLS IT. Calling one hook from several zones is
// one implementation with several readers; handing the answer down from the host
// would have made the host know what every zone is for.

import { useMemo } from "react";

import { useSessionPartition } from "@renderer/store/session/hooks/useOpenSessionStore.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import type { ConsolePaneAddress } from "@renderer/console/seats/index.js";
import {
  resolveComposerTarget,
  type ComposerTarget,
} from "@renderer/shell/composer/chips/chip-models.js";

/** Everything the composer's zones read off one address. */
export interface ComposerAddress {
  readonly target: ComposerTarget;
}

/** Resolve the composer's address within one session. */
export function useComposerAddress(
  sessionStore: SessionStore,
  focusedPane: ConsolePaneAddress | undefined,
): ComposerAddress {
  const agents = useSessionPartition(sessionStore, "agent");
  const runs = useSessionPartition(sessionStore, "run");
  const sessionId = sessionStore.sessionId;
  return useMemo(
    () => ({ target: resolveComposerTarget({ sessionId, focusedPane, agents, runs }) }),
    [sessionId, focusedPane, agents, runs],
  );
}
