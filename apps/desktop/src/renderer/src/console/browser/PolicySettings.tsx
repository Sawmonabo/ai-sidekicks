// The two node-wide browser switches, and nothing else about the browser.
//
// `Spec-023 §Console Design (Meridian)` 13.16 is emphatic about the scope: this row
// pair is the WHOLE of the browser's presence in settings, and 12.5 closes the other
// end — "Policy is invisible until it refuses. The two settings rows live in
// chapter 13." So a navigation refusal renders in the pane and never here, and a
// policy row renders here and nowhere else.
//
// THREE DECISIONS THIS COMPONENT MAKES.
//
//   • **The label says what turning it on stops enforcing.** 13.16 requires it of
//     the file-boundary switch in terms, and the page-tools switch carries the same
//     obligation in the other direction — "Off withholds the tools from every
//     subsequent spawn; running sessions keep the registry they were spawned with,
//     and the row says so." Both sentences are in the traits table below, beside the
//     switch they belong to, because a consequence written anywhere else is a
//     consequence that can be edited without the control moving.
//
//   • **An unread switch renders fail-closed AND says it was not read.** The two are
//     not the same claim and the row makes both. The rendered position is the safe
//     one — the boundary enforced, the tools withheld — because a control whose
//     state nobody established must not draw the permissive position; and the
//     refusal beside it carries the daemon's own code and sentence, so nobody reads
//     the safe position as a reading. `Spec-023 §Console Design (Meridian)` rule 8's
//     whole point is that "nobody asked" and "the answer is no" are different facts.
//
//   • **The switch id is the console's, not the wire's.** The shell-config
//     preference KEYS are unregistered — they are a `settings-key` prerequisite on
//     `Plan-023 §Console growth slate`'s shell-config row — so this component names
//     its two switches with console-local identifiers and hands one back on toggle.
//     Inventing the key strings here would put a wire vocabulary in the renderer
//     ahead of the document that owns minting it.
//
// The component reads nothing and writes nothing: readings arrive as props and a
// toggle leaves as a callback. That is what keeps it a projection of daemon state
// rather than a second place the node's policy is decided.

import type { ConsoleRefusal } from "../core/index.js";
import { PolicyRow } from "./PolicyRow.js";

/**
 * The two switches, as console-local ids. Closed at two by 13.16 — "Hold the two
 * node-wide switches the browser pane's policy reads, and nothing else about the
 * browser" — with the union derived from the tuple so a third cannot be added to one
 * without the other.
 */
export const BROWSER_POLICY_SWITCHES = ["file-boundary", "page-tools"] as const;

export type BrowserPolicySwitchId = (typeof BROWSER_POLICY_SWITCHES)[number];

/**
 * What the node reported about one switch, or why it did not.
 *
 * Two arms rather than `boolean | undefined`: an absent reading has a REASON, and a
 * row that could not render the reason would be back to showing a bare off position
 * for a question nobody put.
 */
export type BrowserPolicySwitchReading =
  | { readonly status: "read"; readonly enabled: boolean }
  | { readonly status: "unread"; readonly refusal: ConsoleRefusal };

export interface BrowserPolicySettingsProps {
  /** Total over the switch set — a row with no reading is not representable. */
  readonly readings: Readonly<Record<BrowserPolicySwitchId, BrowserPolicySwitchReading>>;
  /**
   * Absent while no writer is registered. The rows then render read-only and say
   * so, rather than offering a control whose press goes nowhere.
   */
  readonly onToggle?: ((switchId: BrowserPolicySwitchId, nextEnabled: boolean) => void) | undefined;
}

export function BrowserPolicySettings(props: BrowserPolicySettingsProps): React.JSX.Element {
  return (
    <ul className="meridian-browser-policy">
      {BROWSER_POLICY_SWITCHES.map((switchId) => (
        <PolicyRow
          key={switchId}
          switchId={switchId}
          reading={props.readings[switchId]}
          onToggle={props.onToggle}
        />
      ))}
    </ul>
  );
}
