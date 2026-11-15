import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import {
  useSessionPartition,
  useSessionStore,
} from "#renderer/store/session/hooks/useOpenSessionStore.js";
import { useProviderSections } from "#renderer/store/providers/hooks/useProviderSections.js";
import { providerNameOf } from "#renderer/store/providers/name.js";
import { type ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import { selectTranscript } from "#renderer/store/session/selectors.js";
import { type SessionStoreState } from "#renderer/store/session/state.js";
import { HeldValueKey } from "#renderer/store/session/held-values.js";
import { type SessionStore } from "#renderer/store/session/store.js";
import { SentMessagePlacement, type PlacedQueue, type WaitingRow } from "../../queue/placement.js";
import { type RunEntitiesByRunId } from "../../runs/groups.js";
import { type ProviderNameOf } from "../../system-messages/kinds.js";
import { TranscriptWindowDerivation, type TranscriptWindowModel } from "../transcript-window.js";

/**
 * One session's log window unfurled, the waiting rows that follow it, and the derivation that keeps
 * both across the store's revisions.
 */
export interface TranscriptProjection {
  /** The log's rows, with no waiting row among them: what the run group fold reads. */
  readonly logWindow: TranscriptWindowModel;
  /** The waiting rows' events, in the order drawn, which follow every row of `logWindow`. */
  readonly waitingTail: readonly ProjectedSessionEvent[];
  /** The waiting rows by key, in the order drawn. */
  readonly waitingRowByKey: ReadonlyMap<string, WaitingRow>;
  /** The key a log event drawn under a send's key is drawn under, by the event's id. */
  readonly rowKeyByEventId: ReadonlyMap<string, string>;
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
 * headers read, and to the messages this window sent, which `queueItems` and `retriedItemFrom`,
 * the session's queue as its reading stands, place with them.
 */
export function useTranscriptProjection(
  sessionStore: SessionStore,
  queueItems: PlacedQueue["items"],
  retriedItemFrom: PlacedQueue["retriedItemFrom"],
): TranscriptProjection {
  const transcript = useSessionStore(sessionStore, selectTranscript);
  const isTailLive = useSessionStore(sessionStore, selectIsTailLive);
  const runEntities = useSessionPartition(sessionStore, "run");
  const { sentMessages } = sessionStore;
  const sentEntries = useSyncExternalStore(sentMessages.subscribe, sentMessages.snapshot);
  const held = sessionStore.heldValues.valueOf(HELD_WINDOW, () => ({
    derivation: new TranscriptWindowDerivation(),
    placement: new SentMessagePlacement(sessionStore.sessionId),
  }));
  const queue = useMemo<PlacedQueue>(
    () => ({ items: queueItems, retriedItemFrom }),
    [queueItems, retriedItemFrom],
  );
  const providerSections = useProviderSections();
  const nameOfProvider = useCallback<ProviderNameOf>(
    (providerId) => providerNameOf(providerSections, providerId),
    [providerSections],
  );
  const deriveHeldWindow = useCallback(
    (heldTranscript: readonly ProjectedSessionEvent[]) =>
      held.derivation.derive(
        held.placement.place(heldTranscript, sentEntries, queue, isTailLive).events,
        runEntities,
        nameOfProvider,
      ),
    [held, sentEntries, queue, isTailLive, runEntities, nameOfProvider],
  );
  // A placement of its own, so a read's events leave the one the window's rows keep untouched. A
  // read is of the log behind the window, where no row waits.
  const sessionId = sessionStore.sessionId;
  const placeSentMessages = useCallback(
    (events: readonly ProjectedSessionEvent[]) =>
      new SentMessagePlacement(sessionId).place(events, sentEntries, queue, false).events,
    [sessionId, sentEntries, queue],
  );
  const placed = useMemo(
    () => held.placement.place(transcript, sentEntries, queue, isTailLive),
    [held, transcript, sentEntries, queue, isTailLive],
  );
  // After the pass that found them: a send the service reported waits from then on only while its
  // queue item says so, and a send no row of the store's window reads any longer is let go.
  const { reportedKeys, releasableKeys } = placed;
  useEffect(() => {
    if (reportedKeys.size > 0) {
      sentMessages.noteReported(reportedKeys);
    }
    if (releasableKeys.size > 0) {
      sentMessages.release(releasableKeys);
    }
  }, [sentMessages, reportedKeys, releasableKeys]);
  return useMemo(
    () => ({
      logWindow: held.derivation.derive(placed.events, runEntities, nameOfProvider),
      waitingTail: placed.waitingEvents,
      waitingRowByKey: placed.waitingRowByKey,
      rowKeyByEventId: placed.rowKeyByEventId,
      runEntities,
      deriveHeldWindow,
      placeSentMessages,
      providerNameOf: nameOfProvider,
    }),
    [placed, runEntities, held, deriveHeldWindow, placeSentMessages, nameOfProvider],
  );
}

/** One session's derivation and the placement its log passes through first. */
interface HeldWindow {
  readonly derivation: TranscriptWindowDerivation;
  readonly placement: SentMessagePlacement;
}

/**
 * One derivation per session store, held by the store as long as it lives and read during render,
 * so the first pass over a session already uses that session's and a navigation never carries
 * another session's rows over. It outlives the feed's mount because it carries the counts of the
 * rows the store let go from inside its window, which a feed mounted again could not count.
 */
const HELD_WINDOW = new HeldValueKey<HeldWindow>();

// Whether the store's window ends at the log's newest event, the one place waiting rows stand.
function selectIsTailLive(state: SessionStoreState): boolean {
  return state.transcriptTail.following === "live";
}
