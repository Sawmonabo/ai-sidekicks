// One policy row: the control, its label, its consequence, and its default.
//
// The switch traits travel with the row because it is their only reader; the list composes
// rows and decides nothing about what a switch says about itself. The row is the list's own
// composition and is not exported through the feature's entry.

import { Switch } from "@base-ui/react/switch";

import type { BrowserPolicySwitchId, BrowserPolicySwitchWriter } from "../policy-switches.js";

/** What one switch says about itself. Nothing here is about its current state. */
interface BrowserPolicySwitchTraits {
  readonly label: string;
  /** What turning it on — or off — stops doing. */
  readonly consequence: string;
  /** The node default, stated so a reader can tell a reading from a fallback. */
  readonly defaultLabel: string;
}

/** Total over `BrowserPolicySwitchId`, so a third switch fails to compile until it has traits. */
const BROWSER_POLICY_SWITCH_TRAITS: Readonly<
  Record<BrowserPolicySwitchId, BrowserPolicySwitchTraits>
> = {
  "file-boundary": {
    label: "Open local files outside this session's repo mounts",
    consequence:
      "On, a browser pane may open a file: destination anywhere on this machine. Off, it opens one only inside an admitted root of a repo mount attached to the session, and anything else is refused.",
    defaultLabel: "Off by default",
  },
  "page-tools": {
    label: "Serve the page tool set into sessions on this node",
    consequence:
      "Off withholds the tools from every subsequent spawn. Sessions already running keep the tool set they were spawned with, so turning this off does not reach into a run in progress.",
    defaultLabel: "On by default",
  },
};

/**
 * One row: the control, its label, its consequence, and the default the node ships with.
 * Used by the list only; the feature's index does not re-export it.
 */
export function PolicyRow(props: PolicyRowProps): React.JSX.Element {
  const traits = BROWSER_POLICY_SWITCH_TRAITS[props.switchId];
  const labelId = `meridian-browser-policy-${props.switchId}`;

  return (
    <li className="meridian-browser-policy__row">
      <Switch.Root
        className="meridian-browser-switch"
        aria-labelledby={labelId}
        checked={props.enabled}
        onCheckedChange={(nextEnabled) => {
          props.onToggle(props.switchId, nextEnabled);
        }}
      >
        <Switch.Thumb className="meridian-browser-switch__thumb" />
      </Switch.Root>
      <div className="meridian-browser-policy__text">
        <span className="meridian-browser-policy__label" id={labelId}>
          {traits.label}
        </span>
        <p className="meridian-browser-policy__consequence">{traits.consequence}</p>
        <span className="meridian-browser-policy__default">{traits.defaultLabel}</span>
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
