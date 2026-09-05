// The notifications page: what earns an interruption.
//
// `Spec-023 §Console Design (Meridian)` §Notifications: "Renders the stored
// preference set, and the shell-local mute for OS toasts. Preferences are global in
// this release, with no per-session tier … Never offers a per-session preference,
// and never implies one exists. Never suppresses actionable attention when OS
// notifications are denied; in-app badges and summaries still render."
//
// THE PREFERENCE SET IS READ, AND THE CHAIN STARTS WITH WHO YOU ARE
//
// The stored set is keyed by PARTICIPANT, so the read cannot be made until this
// window knows which participant it is — and no read hands it that directly. What
// does is the caller-identity read, scoped to the session the console has open. So
// the page performs two calls in order: which participant this window is, then the
// preferences stored for that participant. A refusal on the first is rendered as
// the answer to the second, because it IS the answer: nothing was asked of the
// preference store, and guessing a participant would attach one person's answers to
// another person's screen.
//
// The set is GLOBAL to the participant. The session is how the identity is resolved
// and never a scope for the preferences themselves — there is no per-session tier
// anywhere on this page, including in its copy.
//
// ONE RULE DECIDES HOW A STORED PREFERENCE IS SHOWN
//
// No key is named here, because the corpus names none: the stored value is an opaque
// record "until a document names the keys". So the rule is structural and lives in
// `attention-preference-model.ts` — a value whose members are all booleans is drawn
// as one switch per member, labelled with that member's own name; anything else is
// shown read-only exactly as it arrived. No default is ever drawn, because a default
// on this screen would look like the person's own answer.
//
// A SWITCH WRITES THE WHOLE VALUE BACK, AND ONLY ONE AT A TIME PER RECORD
//
// The update carries a record rather than a patch, so a toggle sends the whole value
// with one member flipped. On a served write the set is RE-READ rather than patched
// locally: the daemon owns the record, and a page holding its own edited copy is a
// second version of it that nothing can reconcile. The reply's timestamp is not
// rendered for the same reason — it would be a second truth about a record this page
// is about to read again.
//
// Because the write is whole-record, two switches inside one record cannot be in
// flight at once: composed from the same starting value, the second would erase the
// first member's change. So the whole record goes busy while its write is out — every
// switch in it stops taking presses and the record says so with `aria-busy` — and the
// serialisation itself belongs to `notification-preference-writer.ts`, which also
// decides what a toggle arriving mid-flight is composed against.
//
// WHAT IS REACHABLE WITHOUT THE DAEMON IS THE MUTE, AND IT IS GLOBAL
//
// The OS-toast mute is shell-local, so it rides the shell-config preference carrier
// every settings toggle shares (`shell-preferences-store.ts`). It is offered once, for this
// machine.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { useAnnounce } from "../../../primitives/index.js";
import { consoleRefusalFrom } from "../../../seats/index.js";
import { useSubjectScopedState } from "../../../store/index.js";
import {
  announcementFor,
  type AttentionPreferenceReading,
  type CallerParticipantReading,
} from "./attention-preference-model.js";
import { NotificationPreferenceWriter } from "./notification-preference-writer.js";
import { PreferenceToggleRow } from "../../shared/PreferenceToggleRow.js";
import { useShellPreferences } from "../shell-preferences/shell-preferences-holder.js";
import type { SettingsPageContext, SettingsPageRegistry } from "../../settings-page-registry.js";
import { StoredPreferences } from "./StoredPreferences.js";
import { type StoredPreferenceBinding } from "./StoredPreferenceValue.js";

/** The lane that owns this page, so an unfilled section names someone. */
const OWNER = "collaboration-settings-notifications";

/** The one key this page spends. Named once so the row and its note cannot drift. */
const OS_TOAST_MUTE_KEY = "notifications.osToastsMuted";

/** Names a read that produced no outcome at all, where the thrown value named none. */
const ATTENTION_PREFERENCE_ORIGIN = "attention-preference";

export function NotificationsPage(props: { readonly context: SettingsPageContext }): ReactNode {
  const shellPreferences = useShellPreferences(props.context.bridge);
  const stored = useStoredAttentionPreferences(props.context);
  const isMuted = shellPreferences.isEnabled(OS_TOAST_MUTE_KEY);
  return (
    <div className="meridian-settings-page">
      <p className="meridian-settings-page__lede">
        These preferences are global to this account. There is no per-session tier — a session
        cannot be made noisier or quieter than the rest.
      </p>

      <section
        className="meridian-settings-page__block"
        aria-label="Operating system notifications"
      >
        <h3 className="meridian-settings-page__block-title">Notifications from the desktop</h3>
        <PreferenceToggleRow
          label="Mute system notifications on this machine"
          description="Stops this computer raising desktop notifications. It is a setting for this machine and travels nowhere."
          checked={isMuted}
          isPending={shellPreferences.isPending(OS_TOAST_MUTE_KEY)}
          note={
            shellPreferences.isHeldLocally(OS_TOAST_MUTE_KEY)
              ? "Held in this window. The shell preference store has not been built yet, so the choice lasts until this window closes."
              : undefined
          }
          refusal={shellPreferences.refusalFor(OS_TOAST_MUTE_KEY)}
          onCheckedChange={(checked) => {
            shellPreferences.choose(OS_TOAST_MUTE_KEY, checked);
          }}
        />
        <p className="meridian-settings-page__aside">
          Muting the desktop never mutes the console. Anything waiting on you keeps its badge in the
          rail and its row in the notification center, whether this machine is allowed to raise a
          notification or not.
        </p>
      </section>

      <section className="meridian-settings-page__block" aria-label="What earns an interruption">
        <h3 className="meridian-settings-page__block-title">What earns an interruption</h3>
        <p className="meridian-settings-page__aside">
          These are the daemon&rsquo;s own records, shown under their own names. Where a stored
          value is a set of switches it is offered as switches; anything else is shown as it arrived
          and cannot be edited here. Changing one writes the whole value back.
        </p>
        <StoredPreferences
          binding={stored}
          hasSession={props.context.retainedSessionId !== undefined}
        />
      </section>
    </div>
  );
}

/**
 * The two reads, in order, and the writer that owns everything after them.
 *
 * A hook rather than a render body: it owns two effects and the staleness guards that
 * keep a reply from a session nobody is looking at any more from landing on this one.
 * Everything a switch does once the set is on screen — the write, the record's lock,
 * the queue behind it, the re-read — belongs to the writer this hook builds.
 */
function useStoredAttentionPreferences(context: SettingsPageContext): StoredPreferenceBinding {
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

  useEffect(() => {
    if (participantId === undefined) {
      return undefined;
    }
    let isAttached = true;
    void bridge.growth.attentionPreferenceRead({ participantId }).then(
      (outcome) => {
        publishPreferenceReading({ kind: "answered", outcome });
        if (isAttached && !hasAnnouncedRef.current) {
          hasAnnouncedRef.current = true;
          announce(announcementFor(outcome));
        }
      },
      (rejection: unknown) => {
        const refusal = consoleRefusalFrom(rejection, ATTENTION_PREFERENCE_ORIGIN);
        publishPreferenceReading({ kind: "unreadable", refusal });
        if (isAttached && !hasAnnouncedRef.current) {
          hasAnnouncedRef.current = true;
          announce(refusal.detail);
        }
      },
    );
    return () => {
      isAttached = false;
    };
  }, [bridge, participantId, announce, publishPreferenceReading]);

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
    isRecordBusy: (recordKey) => writes.busyRecordKeys.has(recordKey),
    refusalFor: (memberKey) => writes.refusalByMemberKey.get(memberKey),
    toggleMember: (row, member) => {
      writer.toggle(row, member);
    },
  };
}

/** Claim the notifications section. See `RuntimeNodesPage.tsx` on the seam's shape. */
export function registerNotificationsPage(registry: SettingsPageRegistry): void {
  registry.register({
    section: "notifications",
    owner: OWNER,
    label: "Notifications",
    keywords: [
      "alerts",
      "toasts",
      "mute",
      "attention",
      "interruptions",
      "badges",
      "do not disturb",
    ],
    render: (context) => <NotificationsPage context={context} />,
  });
}
