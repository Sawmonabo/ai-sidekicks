// The browser's page in settings: the machine's three browser switches, each written to the
// settings file as it changes.
//
// Each switch's row stands with its label from the first frame and shows the switch only once the
// settings file has been read, so none shows a value the file does not hold. A refused write
// leaves its switch where it was and draws the refusal in the strip under it, with `Try again`
// sending the same change again.

import type { Clock } from "#renderer/lib/clock.js";
import {
  MachineSettingSwitchRow,
  type MachineSettingSwitchRowProps,
  type MachineSettingsSwitchMember,
} from "#renderer/features/settings/components/MachineSettingSwitchRow.js";
import type { SettingsControl } from "../../types.js";
import { BROWSER_CONTROLS } from "./controls.js";

/** One switch: the member it writes, the control search finds, and the lines under it. */
interface BrowserSwitchRow {
  readonly member: MachineSettingsSwitchMember;
  readonly control: SettingsControl;
  readonly descriptionLines: readonly string[];
}

/** The page's switches, in the order it draws them. */
const BROWSER_SWITCH_ROWS: readonly BrowserSwitchRow[] = [
  {
    member: "rememberSiteData",
    control: BROWSER_CONTROLS.rememberSiteData,
    descriptionLines: [
      "Logins survive a restart. The Preview pane, a sidekick's browser tools and a workflow's " +
        "browser steps all share this one set.",
    ],
  },
  {
    member: "browserToolsForAgents",
    control: BROWSER_CONTROLS.browserToolsForAgents,
    descriptionLines: [
      "Off leaves the browser tools out of what every sidekick is handed; the app's other tools " +
        "stay.",
      "Every call a sidekick makes still goes through that session's own permission level. " +
        "Nothing here loosens that.",
    ],
  },
  {
    member: "sandboxBackgroundBrowser",
    control: BROWSER_CONTROLS.sandboxBackgroundBrowser,
    descriptionLines: [
      "On runs each page in Chromium's sandbox in the browser the background service opens when " +
        "no desktop app is open, for every session, and for every workflow left on Settings " +
        "default. Takes effect when that browser next starts.",
    ],
  },
];

/** What the Browser page is handed. */
export interface BrowserPageProps {
  /** The machine settings the switches read and write. */
  readonly preferences: MachineSettingSwitchRowProps["preferences"];
  /** The window's clock, which the reading line's delay runs on. */
  readonly clock: Clock;
}

/** The Browser settings page: the machine's browser switches, each standing from the first frame. */
export function BrowserPage(props: BrowserPageProps): React.JSX.Element {
  const { preferences, clock } = props;
  return (
    <div className="meridian-settings-page">
      <section className="meridian-settings-page__block" aria-label="Browser">
        {BROWSER_SWITCH_ROWS.map((row) => (
          <MachineSettingSwitchRow
            key={row.member}
            preferences={preferences}
            member={row.member}
            control={row.control}
            descriptionLines={row.descriptionLines}
            clock={clock}
          />
        ))}
      </section>
    </div>
  );
}
