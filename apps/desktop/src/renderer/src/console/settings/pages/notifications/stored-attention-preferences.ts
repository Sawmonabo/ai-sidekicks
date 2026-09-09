// The two reads this page chains, the re-read that keeps them honest, and the writer
// that owns everything after them.
//
// SPLIT OUT OF THE PAGE because they are two jobs: the page decides what a person
// sees, and this decides what has been asked and when it is asked again. The page had
// grown to hold both, and the read chain is exactly the half that is reviewed against
// different failures — a reply landing on the wrong participant, a set going stale
// behind a window that was away, a write racing its own re-read.
//
// THE SET IS RE-READ, AND IT USED TO BE READ ONCE. Both calls fired from an effect
// keyed on the subject and never again, so a preference changed on another device — or
// by this same participant in a second window — stood wrong on screen for the life of
// the window with nothing saying it was old. The preference set is the PARTICIPANT's
// rather than a session's, so it takes the window's three triggers through
// `store/read/read-triggers.ts` and neither of the session-scoped two: no session's repair
// and no session's timeline bear on a record that is global to a person.
//
// AND EVERY ONE OF THOSE READS IS `attention-preference-read.ts`'. This hook holds no
// read of its own and calls the preference port nowhere: mounting, focus, reconnect,
// and the re-read a served write performs all reach one reading, which schedules them
// through the console's one refresh chokepoint and admits only the newest generation's
// reply. Two of them landing in the order they were not taken in is the failure that
// put a person's accepted toggle back where it started, and it is not a failure a hook
// composed of `useState` cells could have seen.
//
// WHAT STAYS HERE is the chain and the announcement: which participant this window is,
// the reading held for that participant, the writer built over it, and the one
// sentence the settled chain says out loud.

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import { consoleClockFor, type ConsoleBridge } from "../../../bridge/index.js";
import type { ConsoleClock } from "../../../core/index.js";
import { useSettlementAnnouncement } from "../../../primitives/index.js";
import {
  useSubjectScopedResource,
  useSubjectScopedState,
  useWindowReadTriggers,
  type SubjectScopedDisposal,
} from "../../../store/index.js";
import {
  announcementFor,
  type AttentionPreferenceReading,
  type CallerParticipantReading,
} from "./attention-preference-model.js";
import { AttentionPreferenceRead } from "./attention-preference-read.js";
import { ScheduledCallerParticipantRead } from "./scheduled-caller-participant-read.js";
import { NotificationPreferenceWriter } from "./notification-preference-writer.js";
import type { SettingsPageContext } from "../../settings-page-registry.js";
import { type StoredPreferenceBinding } from "./StoredPreferenceValue.js";

/**
 * How a reading whose participant moved is retired, declared once at module scope.
 *
 * At module scope because the hook holds it on a dependency of its own: a disposal
 * minted per render would restart the lifetime effect underneath a reading that had
 * not moved.
 */
const ATTENTION_PREFERENCE_READ_DISPOSAL: SubjectScopedDisposal<AttentionPreferenceRead> = {
  dispose: (read) => {
    read.dispose();
  },
  isClosed: (read) => read.isDisposed,
};

/** The same rule for the identity read in front of it, for the same reason. */
const CALLER_PARTICIPANT_READ_DISPOSAL: SubjectScopedDisposal<ScheduledCallerParticipantRead> = {
  dispose: (read) => {
    read.dispose();
  },
  isClosed: (read) => read.isDisposed,
};

/**
 * The clock this page's readings schedule against, held for the life of a bridge.
 *
 * The scenario's frozen clock under the fixture and the real one otherwise, so these
 * reads' coalescing windows advance exactly when every other console read's does.
 *
 * Resolved through the family's own holder rather than `useConsoleClock`, which reads
 * the bridge PROVIDER: this page is mounted from a settings board that hands it a
 * bridge directly, and reaching for the provider would make the clock a second,
 * stricter requirement than the bridge the page already has. Pinned rather than read
 * per call because the live arm of `consoleClockFor` MINTS — the reading it gives is
 * the same either way, and holding one is what keeps a scheduler armed on a clock that
 * does not change underneath it.
 *
 * Both of this page's chained readings take it from here, so a page cannot come to run
 * its identity read and its preference read on two time bases.
 */
function usePinnedBridgeClock(bridge: ConsoleBridge): ConsoleClock {
  return useSubjectScopedState(bridge, undefined, () => consoleClockFor(bridge)).value;
}

/**
 * The two reads, in order, and the writer that owns everything after them.
 *
 * A hook rather than a render body: it owns the identity read's effect, the reading
 * held for whoever that read named, and the staleness guards that keep a reply from a
 * session nobody is looking at any more from landing on this one. Everything a switch
 * does once the set is on screen — the write, the record's lock, the queue behind it,
 * the re-read — belongs to the writer this hook builds.
 */
export function useStoredAttentionPreferences(
  context: SettingsPageContext,
): StoredPreferenceBinding {
  const { bridge, retainedSessionId } = context;
  const clock = usePinnedBridgeClock(bridge);
  // THE IDENTITY READ IS A SCHEDULED READ HELD FOR THE SESSION IT WAS MADE FOR. It was
  // a `useEffect` keyed on the bridge and the session, which is a read that runs ONCE:
  // a transport outage refused it, the dependencies never moved again, and the section
  // behind it — which takes the participant as its subject — refused every focus and
  // every reconnect for the life of the window. It now declares the same
  // `ReadTriggerTarget` its own set does and takes the same three window triggers, so
  // a later focus asks again and the chain finishes.
  const { value: identityRead } = useSubjectScopedResource(
    bridge,
    retainedSessionId,
    () => new ScheduledCallerParticipantRead({ bridge, sessionId: retainedSessionId, clock }),
    CALLER_PARTICIPANT_READ_DISPOSAL,
  );
  useWindowReadTriggers(identityRead, bridge.transportReconnect);
  const subscribeToIdentity = useCallback(
    (onStoreChange: () => void) => identityRead.subscribe(onStoreChange),
    [identityRead],
  );
  const takeIdentitySnapshot = useCallback(() => identityRead.snapshot(), [identityRead]);
  const participantReading = useSyncExternalStore(
    subscribeToIdentity,
    takeIdentitySnapshot,
    takeIdentitySnapshot,
  );

  const participantId =
    participantReading?.kind === "answered" && participantReading.outcome.status === "served"
      ? participantReading.outcome.value.participantId
      : undefined;

  // ONE READING PER PARTICIPANT, and the participant rather than the session: a person
  // reached through two sessions is the same person, and re-seeding their switches
  // because the route moved would report a read nobody needed to make again. Minted by
  // the subject primitive rather than by a memo, because what ends its life is the
  // PARTICIPANT moving and not the component re-rendering — and the primitive addresses
  // during the render, so the first pass that sees a new person reads that person's own
  // empty seed rather than the previous one's switches.
  const { value: read } = useSubjectScopedResource(
    bridge,
    participantId,
    () => new AttentionPreferenceRead({ bridge, participantId, clock }),
    ATTENTION_PREFERENCE_READ_DISPOSAL,
  );
  // The window half only: this section holds no session store, so the session half
  // would have no timeline and no repair edge to listen to — which is also why the
  // reconnect edge is taken from the bridge rather than from a session's own repair.
  useWindowReadTriggers(read, bridge.transportReconnect);
  const subscribeToRead = useCallback(
    (onStoreChange: () => void) => read.subscribe(onStoreChange),
    [read],
  );
  const takeReadSnapshot = useCallback(() => read.snapshot(), [read]);
  const { reading: preferenceReading, isReadInFlight } = useSyncExternalStore(
    subscribeToRead,
    takeReadSnapshot,
    takeReadSnapshot,
  );

  // THE CHAIN SETTLES ONCE AND SAYS SO ONCE, AND "ONCE" IS KEYED ON WHAT IT SAID. A
  // boolean here reported the first settlement and then went silent for the life of
  // the window, which was right while the identity read ran once and is wrong now that
  // it retries: an attempt that refused announced its refusal, and the focus that
  // succeeded afterwards put a set on screen with nothing said about it. Said through
  // the console's own settlement latch rather than through a ref and an effect written
  // here: this module had the second, and the place two copies of a latch drift is the
  // comparison, where a drift is a sentence a person hears twice with every test still
  // green. What is said is a property of the settled value, which is what that latch
  // takes — the readings are published by classes that hold no announcer at all.
  useSettlementAnnouncement(chainSentenceFor(participantReading, preferenceReading));

  // Rebuilt when the participant changes, because everything it holds — the queue,
  // the busy records, the refusals — belongs to one person's set. The old writer's
  // in-flight replies are released with it, so a reply for a participant nobody is
  // looking at any more lands nowhere.
  const writer = useMemo(
    () =>
      new NotificationPreferenceWriter({
        port: bridge.growth,
        participantId,
        // The reading's own read, so a served write's re-read is ordered against every
        // other read of this set rather than only against other writes — and so the
        // set is replaced in place rather than cleared first, which would return the
        // section to its loading shape on every accepted toggle.
        reReadSet: async () => await read.readSet(),
      }),
    [bridge, participantId, read],
  );
  useEffect(
    () => () => {
      writer.releasePendingWrites();
    },
    [writer],
  );
  const subscribeToWrites = useCallback(
    (onStoreChange: () => void) => writer.subscribe(onStoreChange),
    [writer],
  );
  const readWrites = useCallback(() => writer.snapshot(), [writer]);
  const writes = useSyncExternalStore(subscribeToWrites, readWrites, readWrites);

  return {
    participantReading,
    preferenceReading,
    isReadInFlight,
    isRecordBusy: (recordKey) => writes.busyRecordKeys.has(recordKey),
    refusalFor: (memberKey) => writes.refusalByMemberKey.get(memberKey),
    toggleMember: (row, member) => {
      writer.toggle(row, member);
    },
  };
}

/**
 * What the settled chain says out loud, or nothing because it has not settled.
 *
 * THE CHAIN AND NOT THE LAST LINK, because either link can be where it stops. A read
 * set is the settlement whenever there is one; before that, an identity that refused —
 * in the daemon's own words on the `unavailable` arm, and in the console's on the
 * rejection arm the port has no member for — is the settlement, since nothing behind
 * it will ever run. An identity that answered and a set still in flight is not a
 * settlement at all, and answers with nothing rather than with a sentence about a read
 * that is still out.
 */
function chainSentenceFor(
  participantReading: CallerParticipantReading | undefined,
  preferenceReading: AttentionPreferenceReading | undefined,
): string | undefined {
  if (preferenceReading !== undefined) {
    return sentenceFor(preferenceReading);
  }
  if (participantReading === undefined) {
    return undefined;
  }
  if (participantReading.kind === "unreadable") {
    return participantReading.refusal.detail;
  }
  return participantReading.outcome.status === "served"
    ? undefined
    : participantReading.outcome.detail;
}

/**
 * What one settled preference reading says out loud.
 *
 * The refusal arm carries the console's own sentence for a call that produced no
 * outcome; the answered arm defers to `announcementFor`, which is where the daemon's
 * words are carried verbatim. Two arms and one sentence each, so the announcement is
 * a total function of the reading rather than a branch at the call site.
 */
function sentenceFor(reading: AttentionPreferenceReading): string {
  return reading.kind === "unreadable" ? reading.refusal.detail : announcementFor(reading.outcome);
}
