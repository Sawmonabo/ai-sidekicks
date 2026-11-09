// The browser's page in settings: the machine's three browser switches, each written to the
// settings file as it changes.
//
// The switches are drawn only once the settings file has been read, so none shows a value the
// file does not hold. A refused write leaves its switch where it was and draws the refusal in the
// strip under it, with `Try again` sending the same change again.

import { Fragment, useState, type ReactNode } from "react";
import { MACHINE_SETTINGS_DEFAULTS } from "@ai-sidekicks/contracts/machine/settings";

import { LoadingNotice } from "#renderer/components/LoadingNotice/LoadingNotice.js";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import type { Clock } from "#renderer/lib/clock.js";
import { PreferenceToggleRow } from "#renderer/features/settings/components/PreferenceToggleRow.js";
import type { MachineSettingsBinding } from "#renderer/features/settings/machine/hooks/useMachineSettings.js";

/** The settings members this page writes. */
type BrowserSettingsMember =
  | "rememberSiteData"
  | "browserToolsForAgents"
  | "sandboxBackgroundBrowser";

/** One switch: the member it writes and the words drawn for it. */
interface BrowserSwitchRow {
  readonly member: BrowserSettingsMember;
  readonly label: string;
  readonly description: string;
}

/** The page's switches, in the order it draws them. */
const BROWSER_SWITCH_ROWS: readonly BrowserSwitchRow[] = [
  {
    member: "rememberSiteData",
    label: "Remember site data",
    description:
      "Logins survive a restart. The Preview pane, a sidekick's browser tools and a workflow's " +
      "browser steps all share this one set.",
  },
  {
    member: "browserToolsForAgents",
    label: "Browser tools for sidekicks",
    description:
      "Off leaves the browser tools out of what every sidekick is handed; the app's other tools " +
      "stay. Every call a sidekick makes still goes through that session's own permission level. " +
      "Nothing here loosens that.",
  },
  {
    member: "sandboxBackgroundBrowser",
    label: "Sandbox the background browser",
    description:
      "On runs each page in Chromium's sandbox in the browser the background service opens when " +
      "no desktop app is open, for every session, and for every workflow left on Settings " +
      "default. Takes effect when that browser next starts.",
  },
];

/** What the Browser page is handed. */
export interface BrowserPageProps {
  /** The machine settings the switches read and write. */
  readonly preferences: Pick<
    MachineSettingsBinding,
    "snapshot" | "settings" | "isPending" | "refusalFor" | "choose" | "retry" | "readAgain"
  >;
  /** The window's clock, which the reading line's delay runs on. */
  readonly clock: Clock;
}

/** The Browser settings page: the machine's browser switches once the settings file is read. */
export function BrowserPage(props: BrowserPageProps): React.JSX.Element {
  const { preferences, clock } = props;
  // A read's `Try again` clears the refusal and reopens in one act, so a reopen that fails at once
  // leaves the same line drawn; the press count says it again.
  const [readAgainCount, setReadAgainCount] = useState(0);
  const { reading, readRefusal } = preferences.snapshot;
  let content: ReactNode;
  if (reading !== undefined) {
    content = BROWSER_SWITCH_ROWS.map((row) => renderSwitchRow(row, preferences));
  } else if (readRefusal === undefined) {
    content = <LoadingNotice clock={clock} placement="inline" title="Loading your settings…" />;
  } else {
    content = (
      <InlineRefusal
        code={readRefusal.code}
        detail="Couldn't load your settings"
        onTryAgain={() => {
          setReadAgainCount((count) => count + 1);
          preferences.readAgain();
        }}
        attempt={readAgainCount}
      />
    );
  }
  return (
    <div className="meridian-settings-page">
      <section className="meridian-settings-page__block" aria-label="Browser">
        {content}
      </section>
    </div>
  );
}

/** One switch and, under it while its last write was refused, the refusal with `Try again`. */
function renderSwitchRow(
  row: BrowserSwitchRow,
  preferences: BrowserPageProps["preferences"],
): React.JSX.Element {
  const refusal = preferences.refusalFor(row.member);
  return (
    <Fragment key={row.member}>
      <PreferenceToggleRow
        label={row.label}
        description={row.description}
        checked={preferences.settings[row.member]}
        checkedByDefault={MACHINE_SETTINGS_DEFAULTS[row.member]}
        isPending={preferences.isPending(row.member)}
        onCheckedChange={(checked) => {
          preferences.choose(row.member, checked);
        }}
      />
      {refusal === undefined ? null : (
        <InlineRefusal
          code={refusal.code}
          detail={refusal.detail}
          onTryAgain={() => {
            preferences.retry(row.member);
          }}
        />
      )}
    </Fragment>
  );
}
