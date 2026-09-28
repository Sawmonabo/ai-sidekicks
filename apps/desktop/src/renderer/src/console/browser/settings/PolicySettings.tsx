// The two node-wide browser switches, and nothing else about the browser.
//
// This pair is the whole of the browser's presence in settings, and no policy row is
// placed anywhere else: a navigation refusal renders in the pane and never here.
//
// Each switch's consequence is written in the traits table beside the switch it belongs
// to, so the sentence cannot be edited without the control moving. The file-boundary
// label says what turning it on stops enforcing; the page-tools label says that off
// withholds the tools from every subsequent spawn and that running sessions keep the
// tool set they were spawned with.
//
// The switch ids are the console's own, not the wire's: a toggle hands one back, and the
// renderer names no preference key.
//
// The component reads nothing and writes nothing: positions arrive as props and a toggle
// leaves as a callback, so it stays a projection of daemon state rather than a second
// place the node's policy is decided.

import { PolicyRow } from "./PolicyRow.js";
import {
  BROWSER_POLICY_SWITCHES,
  type BrowserPolicySwitchId,
  type BrowserPolicySwitchWriter,
} from "./policy-switches.js";

export interface BrowserPolicySettingsProps {
  /** The position the node reported for each switch, total over the switch set. */
  readonly positions: Readonly<Record<BrowserPolicySwitchId, boolean>>;
  /** Called with the switch pressed and the position it asks for. */
  readonly onToggle: BrowserPolicySwitchWriter;
}

/** The policy section: one switch row per browser policy switch. */
export function BrowserPolicySettings(props: BrowserPolicySettingsProps): React.JSX.Element {
  return (
    <section className="meridian-browser-settings__section" aria-label="Browser policy">
      <h3 className="meridian-browser-settings__section-title">Policy</h3>
      <ul className="meridian-browser-policy">
        {BROWSER_POLICY_SWITCHES.map((switchId) => (
          <PolicyRow
            key={switchId}
            switchId={switchId}
            enabled={props.positions[switchId]}
            onToggle={props.onToggle}
          />
        ))}
      </ul>
    </section>
  );
}
