// One session's run-to-driver bindings, read off its store.

import type { ProviderName } from "@ai-sidekicks/contracts/provider-account";
import { useMemo } from "react";

import { foldRunDriverBindings } from "../run-driver-bindings.js";
import { type ProjectedSessionEvent } from "@renderer/store/session/entities/entities.js";
import {
  useSessionPartition,
  useSessionStore,
} from "@renderer/store/session/hooks/useOpenSessionStore.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import { type SessionStoreState } from "@renderer/store/session/session-state.js";

/**
 * One session's run-to-driver bindings, as its store currently has them. Folded once per
 * change of either reading, since the join walks the timeline.
 *
 * @consumedBy the composer's run controls
 */
export function useRunDriverBindings(
  sessionStore: SessionStore,
): ReadonlyMap<string, ProviderName> {
  const runs = useSessionPartition(sessionStore, "run");
  const timeline = useSessionStore(sessionStore, selectSessionTimeline);
  return useMemo(() => foldRunDriverBindings(runs, timeline), [runs, timeline]);
}

/** The session timeline, a module-level function so every render passes the same selector. */
function selectSessionTimeline(state: SessionStoreState): readonly ProjectedSessionEvent[] {
  return state.timeline;
}
