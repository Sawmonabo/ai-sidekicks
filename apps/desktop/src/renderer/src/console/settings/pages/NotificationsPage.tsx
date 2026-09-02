// The notifications page: what earns an interruption.
//
// `Spec-023 §Console Design (Meridian)` §Notifications: "Renders the stored
// preference set, and the shell-local mute for OS toasts. Preferences are global in
// this release, with no per-session tier … Never offers a per-session preference,
// and never implies one exists. Never suppresses actionable attention when OS
// notifications are denied; in-app badges and summaries still render."
//
// THE PREFERENCE SET IS NOT REACHABLE, AND THE PAGE SAYS SO RATHER THAN INVENTING IT
//
// That section names `attention.preferenceRead` and `attention.preferenceUpdate`.
// Neither is registered: `packages/contracts` exports no attention type, no
// `SidekicksBridge` namespace names one, and the growth port carries no attention
// operation on any slate row — the same finding `notifications/attention-plane.ts`
// records for the projection read next door. So this page renders the preference
// set as the "not checked" kind of nothing, which is the honest fact, rather than
// drawing toggles that would write nowhere. A console that composed the method
// string anyway would be wiring a surface live against an unregistered wire.
//
// WHAT IS REACHABLE IS THE MUTE, AND IT IS GLOBAL
//
// The OS-toast mute is shell-local, so it rides the shell-config preference carrier
// every settings toggle shares (`shell-preferences.ts`). It is offered once, for
// this machine, with no per-session tier anywhere on the page — including in the
// copy, which never suggests one could exist.

import type { ReactNode } from "react";

import { Nothing } from "../../primitives/index.js";
import { PreferenceToggleRow } from "./PreferenceToggleRow.js";
import { useShellPreferences } from "./shell-preferences.js";
import type { SettingsPageContext, SettingsPageRegistry } from "../settings-page-registry.js";

/** The lane that owns this page, so an unfilled section names someone. */
const OWNER = "collaboration-settings-notifications";

/** The one key this page spends. Named once so the row and its note cannot drift. */
const OS_TOAST_MUTE_KEY = "notifications.osToastsMuted";

export function NotificationsPage(props: { readonly context: SettingsPageContext }): ReactNode {
  const preferences = useShellPreferences(props.context.bridge);
  const isMuted = preferences.isEnabled(OS_TOAST_MUTE_KEY);
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
          isPending={preferences.isPending(OS_TOAST_MUTE_KEY)}
          note={
            preferences.isHeldLocally(OS_TOAST_MUTE_KEY)
              ? "Held in this window. The shell preference store has not been built yet, so the choice lasts until this window closes."
              : undefined
          }
          refusal={preferences.refusalFor(OS_TOAST_MUTE_KEY)}
          onCheckedChange={(checked) => {
            preferences.choose(OS_TOAST_MUTE_KEY, checked);
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
        <Nothing
          kind="not-checked"
          placement="surface"
          title="The stored preference set has not been read."
          detail="Which events are allowed to interrupt you is the daemon's record, and this console has no registered read for it yet. Nothing was asked, so nothing is shown — including a default that would look like your answer."
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
