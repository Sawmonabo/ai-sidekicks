// One session's run-to-driver bindings, read off its store.

import type { ProviderName } from "@ai-sidekicks/contracts/provider-account";
import { useMemo } from "react";

import { foldRunDriverBindings } from "../run-driver-bindings.js";
import {
  useSessionPartition,
  useSessionStore,
} from "@renderer/store/session/hooks/useOpenSessionStore.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import { selectTranscript } from "@renderer/store/session/session-selectors.js";

/**
 * One session's run-to-driver bindings, as its store currently has them. Folded once per
 * change of either reading, since the join walks the transcript.
 *
 * @consumedBy the composer's run controls
 */
export function useRunDriverBindings(
  sessionStore: SessionStore,
): ReadonlyMap<string, ProviderName> {
  const runs = useSessionPartition(sessionStore, "run");
  const transcript = useSessionStore(sessionStore, selectTranscript);
  return useMemo(() => foldRunDriverBindings(runs, transcript), [runs, transcript]);
}
