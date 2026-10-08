// One session's run-to-driver bindings, read off its store.

import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";
import { useMemo } from "react";

import { foldRunDriverBindings } from "../driver-bindings.js";
import {
  useSessionPartition,
  useSessionStore,
} from "#renderer/store/session/hooks/useOpenSessionStore.js";
import { type SessionStore } from "#renderer/store/session/store.js";
import { selectStandingEvents } from "#renderer/store/session/selectors.js";

/**
 * One session's run-to-driver bindings, as its store currently has them. Folded once per
 * change of either reading, since the join walks the standing events.
 *
 * @consumedBy the composer's run controls
 */
export function useRunDriverBindings(
  sessionStore: SessionStore,
): ReadonlyMap<string, ProviderName> {
  const runs = useSessionPartition(sessionStore, "run");
  const standingEvents = useSessionStore(sessionStore, selectStandingEvents);
  return useMemo(() => foldRunDriverBindings(runs, standingEvents), [runs, standingEvents]);
}
