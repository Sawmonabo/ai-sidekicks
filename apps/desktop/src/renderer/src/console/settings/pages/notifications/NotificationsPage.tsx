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

import { type ReactNode } from "react";

import { PreferenceToggleRow } from "../../shared/PreferenceToggleRow.js";
import { useShellPreferences } from "../../shared/shell-preferences/shell-preferences-holder.js";
import type { SettingsPageContext, SettingsPageRegistry } from "../../settings-page-registry.js";
import { OsPermissionNotice } from "./OsPermissionNotice.js";
import { StoredPreferences } from "./StoredPreferences.js";
import {
  useOsNotificationPermission,
  useStoredAttentionPreferences,
} from "./stored-attention-preferences.js";

/** The lane that owns this page, so an unfilled section names someone. */
const OWNER = "collaboration-settings-notifications";

/** The one key this page spends. Named once so the row and its note cannot drift. */
const OS_TOAST_MUTE_KEY = "notifications.osToastsMuted";

export function NotificationsPage(props: { readonly context: SettingsPageContext }): ReactNode {
  const shellPreferences = useShellPreferences(props.context.bridge);
  const stored = useStoredAttentionPreferences(props.context);
  const osPermission = useOsNotificationPermission(props.context.bridge);
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
        <OsPermissionNotice reading={osPermission} />
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
