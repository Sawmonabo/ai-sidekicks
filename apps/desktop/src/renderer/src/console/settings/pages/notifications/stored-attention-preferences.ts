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
// `store/read-triggers.ts` and neither of the session-scoped two: no session's repair
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

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { consoleClockFor, type ConsoleBridge } from "../../../bridge/index.js";
import { useAnnounce } from "../../../primitives/index.js";
import { consoleRefusalFrom } from "../../../seats/index.js";
import {
  NO_TRIGGERING_EVENT_KINDS,
  useSubjectScopedResource,
  useSubjectScopedState,
  useWindowReadTriggers,
  type ReadTriggerTarget,
  type SubjectScopedDisposal,
} from "../../../store/index.js";
import {
  announcementFor,
  type AttentionPreferenceReading,
  type CallerParticipantReading,
} from "./attention-preference-model.js";
import {
  ATTENTION_PREFERENCE_ORIGIN,
  AttentionPreferenceRead,
} from "./attention-preference-read.js";
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
  // The scenario's frozen clock under the fixture and the real one otherwise, so this
  // read's coalescing window advances exactly when every other console read's does.
  //
  // Resolved through the family's own holder rather than `useConsoleClock`, which
  // reads the bridge PROVIDER: this page is mounted from a settings board that hands
  // it a bridge directly, and reaching for the provider would make the clock a
  // second, stricter requirement than the bridge the page already has. Pinned rather
  // than read per call because the live arm of `consoleClockFor` MINTS — the reading
  // it gives is the same either way, and holding one is what keeps the scheduler
  // armed on a clock that does not change underneath it.
  const { value: clock } = useSubjectScopedState(bridge, undefined, () => consoleClockFor(bridge));
  const announce = useAnnounce();
  // THE IDENTITY READ IS HELD FOR THE SUBJECT IT WAS MADE FOR, through the family's one
  // holder. It was a `useState` cell cleared at the top of an effect, and "cleared
  // first" was first WITHIN THE EFFECT — one committed frame after the render that
  // renamed the subject, so that frame painted one session's participant under
  // another's name. The holder is addressed during the render, so the pass that first
  // sees a new subject reads that subject's own seed.
  const { value: participantReading, publish: publishParticipantReading } = useSubjectScopedState<
    CallerParticipantReading | undefined
  >(bridge, retainedSessionId, () => undefined);

  const participantId =
    participantReading?.kind === "answered" && participantReading.outcome.status === "served"
      ? participantReading.outcome.value.participantId
      : undefined;

  // The chain settles once and says so once. Held in a ref rather than in state so
  // announcing never causes the render that would announce again.
  const hasAnnouncedRef = useRef(false);

  useEffect(() => {
    if (retainedSessionId === undefined) {
      return undefined;
    }
    // The publisher guards the VALUE; this flag guards the ANNOUNCEMENT, which it
    // cannot — the announcer is the window's and is addressed by nothing.
    let isAttached = true;
    hasAnnouncedRef.current = false;
    void bridge.growth.callerParticipantRead({ sessionId: retainedSessionId }).then(
      (outcome) => {
        publishParticipantReading({ kind: "answered", outcome });
        if (isAttached && outcome.status === "unavailable" && !hasAnnouncedRef.current) {
          // The chain stopped here, so this refusal IS the settlement — said in the
          // daemon's own words rather than in a sentence about a read never made.
          hasAnnouncedRef.current = true;
          announce(outcome.detail);
        }
      },
      // The chain stops here too, and for a reason the port's own vocabulary has no
      // arm for. Without this the page reports "Finding out who you are" for the life
      // of the window over a call that already failed.
      (rejection: unknown) => {
        const refusal = consoleRefusalFrom(rejection, ATTENTION_PREFERENCE_ORIGIN);
        publishParticipantReading({ kind: "unreadable", refusal });
        if (isAttached && !hasAnnouncedRef.current) {
          hasAnnouncedRef.current = true;
          announce(refusal.detail);
        }
      },
    );
    return () => {
      isAttached = false;
    };
  }, [bridge, retainedSessionId, announce, publishParticipantReading]);

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

  useEffect(() => {
    if (preferenceReading === undefined || hasAnnouncedRef.current) {
      return;
    }
    // In an effect rather than inside the reply's own callback, because the reading is
    // published by a class that holds no announcer: what is said is a property of the
    // settled value, and this is the one place that value and the window's announcer
    // are both in hand.
    hasAnnouncedRef.current = true;
    announce(sentenceFor(preferenceReading));
  }, [announce, preferenceReading]);

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

/**
 * Whether this machine's operating system will let the shell raise a notification.
 *
 * Its own reading and its own hook, because it answers for the MACHINE rather than for
 * a participant: it re-reads on the window's own triggers — a person granting the
 * permission does so outside this application and comes back to it — and it is
 * addressed by no session and no participant. No wire serves it today, which is a row
 * on the growth slate rather than a silence: the page says the question could not be
 * put, and never that the answer was yes.
 */
export type OsNotificationPermissionReading =
  | { readonly kind: "unread" }
  | { readonly kind: "read"; readonly status: "granted" | "denied" | "not-determined" }
  | { readonly kind: "unavailable" };

export function useOsNotificationPermission(
  bridge: ConsoleBridge,
): OsNotificationPermissionReading {
  const { value: reading, publish: publishReading } =
    useSubjectScopedState<OsNotificationPermissionReading>(bridge, undefined, () => ({
      kind: "unread",
    }));
  const target = useMemo<ReadTriggerTarget>(
    () => ({
      triggeringEventKinds: NO_TRIGGERING_EVENT_KINDS,
      requestRead: () => {
        void bridge.growth.attentionOsPermissionRead({}).then(
          (outcome) => {
            publishReading(
              outcome.status === "served"
                ? { kind: "read", status: outcome.value.status }
                : { kind: "unavailable" },
            );
          },
          () => {
            publishReading({ kind: "unavailable" });
          },
        );
      },
    }),
    [bridge, publishReading],
  );
  useWindowReadTriggers(target, bridge.transportReconnect);
  return reading;
}
