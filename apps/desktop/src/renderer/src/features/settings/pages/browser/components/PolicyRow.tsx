// One policy row: the control, its label and its consequence. While the switch is not in the
// position it ships in, the changed mark follows the label and its tooltip names that position.
//
// The switch traits travel with the row because it is their only reader; the list composes
// rows and decides nothing about what a switch says about itself. The row is the list's own
// composition and is not exported through the feature's entry.

import { Switch } from "#renderer/components/Switch/Switch.js";

import { ChangedFromDefaultMark } from "#renderer/features/settings/components/ChangedFromDefaultMark.js";

import type { BrowserPolicySwitchId, BrowserPolicySwitchWriter } from "../policy-switches.js";

/** What one switch says about itself. Nothing here is about its current state. */
interface BrowserPolicySwitchTraits {
  readonly label: string;
  /** What turning it on — or off — stops doing. */
  readonly consequence: string;
  /** The position the node ships the switch in. */
  readonly isOnByDefault: boolean;
}

/** Total over `BrowserPolicySwitchId`, so a third switch fails to compile until it has traits. */
const BROWSER_POLICY_SWITCH_TRAITS: Readonly<
  Record<BrowserPolicySwitchId, BrowserPolicySwitchTraits>
> = {
  "file-boundary": {
    label: "Open local files outside this session's repo mounts",
    consequence:
      "On, a browser pane may open a file: destination anywhere on " +
      "this machine. Off, it opens one only inside an admitted root of " +
      "a repo mount attached to the session, and anything else is " +
      "refused.",
    isOnByDefault: false,
  },
  "page-tools": {
    label: "Serve the page tool set into sessions on this node",
    consequence:
      "Off withholds the tools from every subsequent spawn. Sessions " +
      "already running keep the tool set they were spawned with, so " +
      "turning this off does not reach into a run in progress.",
    isOnByDefault: true,
  },
};

/**
 * One row: the control, its label with the changed mark while it differs from the node's
 * default, and its consequence. Used by the list only; the feature's index does not re-export it.
 */
export function PolicyRow(props: PolicyRowProps): React.JSX.Element {
  const traits = BROWSER_POLICY_SWITCH_TRAITS[props.switchId];
  const switchInputId = `meridian-browser-policy-${props.switchId}`;

  return (
    <li className="meridian-browser-policy__row">
      <Switch
        id={switchInputId}
        checked={props.enabled}
        onCheckedChange={(nextEnabled) => {
          props.onToggle(props.switchId, nextEnabled);
        }}
      />
      <div className="meridian-browser-policy__text">
        <span className="meridian-browser-policy__name">
          <label className="meridian-browser-policy__label" htmlFor={switchInputId}>
            {traits.label}
          </label>
          {props.enabled === traits.isOnByDefault ? null : (
            <ChangedFromDefaultMark isOnByDefault={traits.isOnByDefault} />
          )}
        </span>
        <p className="meridian-browser-policy__consequence">{traits.consequence}</p>
      </div>
    </li>
  );
}

interface PolicyRowProps {
  readonly switchId: BrowserPolicySwitchId;
  /** The position the node reported for this switch. */
  readonly enabled: boolean;
  readonly onToggle: BrowserPolicySwitchWriter;
}
