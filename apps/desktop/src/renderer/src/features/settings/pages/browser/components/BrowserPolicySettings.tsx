// The two node-wide browser switches, and nothing else about the browser in settings; a
// navigation refusal renders in the pane, never here.
//
// Each switch's consequence sits in the traits table beside its control, so the sentence
// cannot change without the control moving. The switch ids are the console's own, not the
// wire's, and the renderer names no preference key. The component reads and writes nothing:
// positions arrive as props and a toggle leaves as a callback, so the node's policy is decided
// in one place.

import { PolicyRow } from "./PolicyRow.js";
import {
  BROWSER_POLICY_SWITCHES,
  type BrowserPolicySwitchId,
  type BrowserPolicySwitchWriter,
} from "../policy-switches.js";

/** Props for {@link BrowserPolicySettings}. */
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
