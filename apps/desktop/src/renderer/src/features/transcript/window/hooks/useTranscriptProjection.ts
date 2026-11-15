import { useCallback, useMemo, useSyncExternalStore } from "react";

import type { QueueItemSummary } from "@ai-sidekicks/contracts/run/queue";

import {
  useSessionPartition,
  useSessionStore,
} from "#renderer/store/session/hooks/useOpenSessionStore.js";
import { useProviderSections } from "#renderer/store/providers/hooks/useProviderSections.js";
import { providerNameOf } from "#renderer/store/providers/name.js";
import { type ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import { selectTranscript } from "#renderer/store/session/selectors.js";
import { type SessionStoreState } from "#renderer/store/session/state.js";
import { type SessionStore } from "#renderer/store/session/store.js";
import { SentMessagePlacement, type WaitingRow } from "../../queue/placement.js";
import { type RunEntitiesByRunId } from "../../runs/groups.js";
import { type ProviderNameOf } from "../../system-messages/kinds.js";
import { TranscriptWindowDerivation, type TranscriptWindowModel } from "../transcript-window.js";

/** One session's unfurled window, and the derivation that keeps it across the store's revisions. */
export interface TranscriptProjection {
  readonly unfurledWindow: TranscriptWindowModel;
  /** The rows of `unfurledWindow` that wait for the agent to take them, by key. */
  readonly waitingRowByKey: ReadonlyMap<string, WaitingRow>;
  /** The store's run entities the window's run groups read, for a reader deriving a window too. */
  readonly runEntities: RunEntitiesByRunId;
  /**
   * Derives a store transcript through the session's one derivation, its messages placed as the
   * window's are: the transcript derived before the feed's render is not derived again in it.
   */
  readonly deriveHeldWindow: (
    transcript: readonly ProjectedSessionEvent[],
  ) => TranscriptWindowModel;
  /**
   * Events read back from the log with the messages placed as the window's are, so a row a read
   * derives carries the key the window drew it under.
   */
  readonly placeSentMessages: (
    events: readonly ProjectedSessionEvent[],
  ) => readonly ProjectedSessionEvent[];
  /** A provider's name from the served provider list, which the window's system messages read. */
  readonly providerNameOf: ProviderNameOf;
}

/**
 * Subscribe to one session's log and project it with every run group's member rows unfurled, so
 * Find counts the rows a closed run group's fold would hide. Subscribes to `transcript`, which the
 * store replaces just when it admits an event, to the run partition, whose facts the run groups'
 * headers read, and to the messages this window sent, which `queueItems`, the session's queue as
 * its reading stands, places with them.
 */
export function useTranscriptProjection(
  sessionStore: SessionStore,
  queueItems: readonly QueueItemSummary[],
): TranscriptProjection {
  const transcript = useSessionStore(sessionStore, selectTranscript);
  const isTailLive = useSessionStore(sessionStore, selectIsTailLive);
  const runEntities = useSessionPartition(sessionStore, "run");
  const { sentMessages } = sessionStore;
  const sentEntries = useSyncExternalStore(sentMessages.subscribe, sentMessages.snapshot);
  const held = heldWindowOf(sessionStore);
  const providerSections = useProviderSections();
  const nameOfProvider = useCallback<ProviderNameOf>(
    (providerId) => providerNameOf(providerSections, providerId),
    [providerSections],
  );
  const deriveHeldWindow = useCallback(
    (heldTranscript: readonly ProjectedSessionEvent[]) =>
      held.derivation.derive(
        held.placement.place(heldTranscript, sentEntries, queueItems, isTailLive).events,
        runEntities,
        nameOfProvider,
      ),
    [held, sentEntries, queueItems, isTailLive, runEntities, nameOfProvider],
  );
  // A placement of its own, so a read's events leave the one the window's rows keep untouched.
  const placeSentMessages = useCallback(
    (events: readonly ProjectedSessionEvent[]) =>
      new SentMessagePlacement().place(events, sentEntries, queueItems, isTailLive).events,
    [sentEntries, queueItems, isTailLive],
  );
  return useMemo(() => {
    const placed = held.placement.place(transcript, sentEntries, queueItems, isTailLive);
    return {
      unfurledWindow: held.derivation.derive(placed.events, runEntities, nameOfProvider),
      waitingRowByKey: placed.waitingRowByKey,
      runEntities,
      deriveHeldWindow,
      placeSentMessages,
      providerNameOf: nameOfProvider,
    };
  }, [
    transcript,
    sentEntries,
    queueItems,
    isTailLive,
    runEntities,
    held,
    deriveHeldWindow,
    placeSentMessages,
    nameOfProvider,
  ]);
}

/** One session's derivation and the placement its log passes through first. */
interface HeldWindow {
  readonly derivation: TranscriptWindowDerivation;
  readonly placement: SentMessagePlacement;
}

/**
 * One derivation per session store, as long as the store lives, read during render so the first
 * pass over a session already uses that session's and a navigation never carries another session's
 * rows over. It outlives the feed's mount because it carries the counts of the rows the store let
 * go from inside its window, which a feed mounted again could not count.
 */
const heldWindowByStore = new WeakMap<SessionStore, HeldWindow>();

function heldWindowOf(sessionStore: SessionStore): HeldWindow {
  const held = heldWindowByStore.get(sessionStore);
  if (held !== undefined) {
    return held;
  }
  const created = {
    derivation: new TranscriptWindowDerivation(),
    placement: new SentMessagePlacement(),
  };
  heldWindowByStore.set(sessionStore, created);
  return created;
}

// Whether the store's window ends at the log's newest event, the one place waiting rows stand.
function selectIsTailLive(state: SessionStoreState): boolean {
  return state.transcriptTail.following === "live";
}
