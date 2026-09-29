// One session's run-to-driver bindings, read off its store.
//
// The join itself, and why it reads two sources, is `foldRunDriverBindings`'s.

import { useMemo } from "react";

import { foldRunDriverBindings } from "@renderer/console/bridge/driver-capabilities/run-driver-binding.js";
import { type ConsoleSessionEvent } from "@renderer/console/store/entities/entities.js";
import {
  useSessionPartition,
  useSessionStore,
} from "@renderer/store/session/hooks/useOpenSessionStore.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import { type SessionStoreState } from "@renderer/store/session/session-state.js";

/**
 * One session's run-to-driver bindings, as its store currently has them.
 *
 * Folded once per change of either reading rather than at each render: the join
 * walks the timeline, and a render body that rebuilt it would do that on every
 * keystroke in the composer.
 *
 * @consumedBy the composer's run controls
 */
export function useRunDriverBindings(sessionStore: SessionStore): ReadonlyMap<string, string> {
  const runs = useSessionPartition(sessionStore, "run");
  const timeline = useSessionStore(sessionStore, selectSessionTimeline);
  return useMemo(() => foldRunDriverBindings(runs, timeline), [runs, timeline]);
}

/** The session timeline, a module-level function so every render passes the same selector. */
function selectSessionTimeline(state: SessionStoreState): readonly ConsoleSessionEvent[] {
  return state.timeline;
}
