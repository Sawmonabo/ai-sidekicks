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
// rather than a session's, so it takes the window's two triggers through
// `store/read-triggers.ts` and neither of the session-scoped two: no session's repair
// and no session's timeline bear on a record that is global to a person.
//
// AND A RE-READ NEVER BLANKS WHAT IS ON SCREEN. The in-flight flag below is held
// BESIDE the reading rather than replacing it, so the rows a person is looking at stay
// where they are and go unpressable while the answer is refreshed. A reading cleared
// first would return the section to its opening shape on every window focus, which
// reads as the console forgetting.

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import type { ConsoleBridge } from "../../../bridge/index.js";
import { useAnnounce } from "../../../primitives/index.js";
import { consoleRefusalFrom } from "../../../seats/index.js";
import {
  NO_TRIGGERING_EVENT_KINDS,
  useSubjectScopedState,
  useWindowReadTriggers,
  type ReadTriggerTarget,
} from "../../../store/index.js";
import {
  announcementFor,
  type AttentionPreferenceReading,
  type CallerParticipantReading,
} from "./attention-preference-model.js";
import { NotificationPreferenceWriter } from "./notification-preference-writer.js";
import type { SettingsPageContext } from "../../settings-page-registry.js";
import { type StoredPreferenceBinding } from "./StoredPreferenceValue.js";

/** Names a read that produced no outcome at all, where the thrown value named none. */
const ATTENTION_PREFERENCE_ORIGIN = "attention-preference";

/**
 * The two reads, in order, and the writer that owns everything after them.
 *
 * A hook rather than a render body: it owns two effects and the staleness guards that
 * keep a reply from a session nobody is looking at any more from landing on this one.
 * Everything a switch does once the set is on screen — the write, the record's lock,
 * the queue behind it, the re-read — belongs to the writer this hook builds.
 */
export function useStoredAttentionPreferences(
  context: SettingsPageContext,
): StoredPreferenceBinding {
  const { bridge, retainedSessionId } = context;
  const announce = useAnnounce();
  // BOTH READS ARE HELD FOR THE SUBJECT THEY WERE MADE FOR, through the family's one
  // holder. Both were `useState` cells cleared at the top of an effect, and "cleared
  // first" was first WITHIN THE EFFECT — one committed frame after the render that
  // renamed the subject, so that frame painted one session's participant and one
  // person's stored switches under another's name. The holder is addressed during the
  // render, so the pass that first sees a new subject reads that subject's own seed.
  //
  // Two subjects and not one: the participant read is about the SESSION, and the
  // preference read is about the PARTICIPANT that read resolved — a person reached
  // through two sessions is the same person, and re-seeding their switches because
  // the route moved would report a read nobody needed to make again.
  const { value: participantReading, publish: publishParticipantReading } = useSubjectScopedState<
    CallerParticipantReading | undefined
  >(bridge, retainedSessionId, () => undefined);

  const participantId =
    participantReading?.kind === "answered" && participantReading.outcome.status === "served"
      ? participantReading.outcome.value.participantId
      : undefined;

  const {
    value: preferenceReading,
    publish: publishPreferenceReading,
    settle: settlePreferenceReading,
  } = useSubjectScopedState<AttentionPreferenceReading | undefined>(
    bridge,
    participantId,
    () => undefined,
  );
  // Beside the reading and never in place of it, so a refresh disables the rows a
  // person is looking at rather than removing them.
  const { value: isReadInFlight, publish: publishReadInFlight } = useSubjectScopedState<boolean>(
    bridge,
    participantId,
    () => false,
  );
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

  const preferenceReadTarget = useMemo<ReadTriggerTarget>(
    () => ({
      // Empty, and the emptiness is the claim: this set is global to a PARTICIPANT, so
      // nothing in any session's timeline says it moved.
      triggeringEventKinds: NO_TRIGGERING_EVENT_KINDS,
      requestRead: () => {
        if (participantId === undefined) {
          return;
        }
        publishReadInFlight(true);
        void bridge.growth.attentionPreferenceRead({ participantId }).then(
          (outcome) => {
            publishReadInFlight(false);
            publishPreferenceReading({ kind: "answered", outcome });
            if (!hasAnnouncedRef.current) {
              hasAnnouncedRef.current = true;
              announce(announcementFor(outcome));
            }
          },
          (rejection: unknown) => {
            publishReadInFlight(false);
            const refusal = consoleRefusalFrom(rejection, ATTENTION_PREFERENCE_ORIGIN);
            publishPreferenceReading({ kind: "unreadable", refusal });
            if (!hasAnnouncedRef.current) {
              hasAnnouncedRef.current = true;
              announce(refusal.detail);
            }
          },
        );
      },
    }),
    [bridge, participantId, announce, publishPreferenceReading, publishReadInFlight],
  );
  useWindowReadTriggers(preferenceReadTarget, bridge.transportReconnect);

  // Rebuilt when the participant changes, because everything it holds — the queue,
  // the busy records, the refusals — belongs to one person's set. The old writer's
  // in-flight replies are released with it, so a reply for a participant nobody is
  // looking at any more lands nowhere.
  const writer = useMemo(
    () =>
      new NotificationPreferenceWriter({
        port: bridge.growth,
        participantId,
        // Replaced in place and never cleared first, so the re-read a served write
        // triggers does not return the section to its loading shape.
        //
        // Through the holder's SETTLE moment rather than the render-time publisher:
        // this writer is built once per participant and the publisher it would have
        // closed over is re-captured whenever the addressing moves, so a writer built
        // on one visit would keep writing through a publisher the holder has retired.
        // `settle` names the visit on screen when it is CALLED, which is the visit a
        // re-read is about.
        onRecordsRead: (outcome) => {
          settlePreferenceReading()({ kind: "answered", outcome });
        },
      }),
    [bridge, participantId, settlePreferenceReading],
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
