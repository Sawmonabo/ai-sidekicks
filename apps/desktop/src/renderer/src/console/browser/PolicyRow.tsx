// One policy row: the control, its label, its consequence, and its honesty about
// whether the position drawn is a reading.
//
// A module of its own because `test/console/architecture/one-component-per-module.test.ts`
// holds every `.tsx` to one component: two components in one file are two things a
// reviewer has to separate by eye, and the second one is the one that quietly grows.
// The switch TRAITS travel with it rather than staying beside the list, because the
// row is their only reader — the list composes rows and decides nothing about what a
// switch says about itself.
//
// Not exported through the family door. It is the list's own composition, and a row
// rendered outside that list would be a policy row somewhere 13.16 forbids one.

import { Switch } from "@base-ui/react/switch";

import { InlineRefusal, Nothing } from "../primitives/index.js";
import type {
  BrowserPolicySwitchId,
  BrowserPolicySwitchReading,
  BrowserPolicySwitchWriter,
} from "./policy-switches.js";

/** What one switch says about itself. Nothing here is about its current state. */
interface BrowserPolicySwitchTraits {
  readonly label: string;
  /** What turning it on — or off — stops doing. 13.16 requires this sentence. */
  readonly consequence: string;
  /** The node default, stated so a reader can tell a reading from a fallback. */
  readonly defaultLabel: string;
  /**
   * The position drawn when nothing was read. Both are the conservative arm of
   * their own switch, which is why this is a trait rather than a constant `false`:
   * for one switch the safe position is off, for the other it is also off, and
   * stating it per switch keeps that a decision rather than a coincidence.
   */
  readonly failClosedPosition: boolean;
}

/**
 * Total over `BrowserPolicySwitchId` by construction — a third switch fails to
 * compile here before it can reach a row that renders a nameless control.
 */
const BROWSER_POLICY_SWITCH_TRAITS: Readonly<
  Record<BrowserPolicySwitchId, BrowserPolicySwitchTraits>
> = {
  "file-boundary": {
    label: "Open local files outside this session's repo mounts",
    consequence:
      "On, a browser pane may open a file: destination anywhere on this machine. Off, it opens one only inside an admitted root of a repo mount attached to the session, and anything else is refused.",
    defaultLabel: "Off by default",
    failClosedPosition: false,
  },
  "page-tools": {
    label: "Serve the page tool set into sessions on this node",
    consequence:
      "Off withholds the tools from every subsequent spawn. Sessions already running keep the tool set they were spawned with, so turning this off does not reach into a run in progress.",
    defaultLabel: "On by default",
    failClosedPosition: false,
  },
};

interface PolicyRowProps {
  readonly switchId: BrowserPolicySwitchId;
  readonly reading: BrowserPolicySwitchReading;
  readonly onToggle?: BrowserPolicySwitchWriter | undefined;
}

/**
 * One row: the control, its label, its consequence, and its honesty about whether
 * the position drawn is a reading.
 *
 * Exported to its list and to nothing else — it carries no door line, so the family
 * barrel cannot publish it and a row rendered outside that list would be a policy row
 * somewhere 13.16 forbids one.
 */
export function PolicyRow(props: PolicyRowProps): React.JSX.Element {
  const traits = BROWSER_POLICY_SWITCH_TRAITS[props.switchId];
  const isRead = props.reading.status === "read";
  const position = isRead ? props.reading.enabled : traits.failClosedPosition;
  const labelId = `meridian-browser-policy-${props.switchId}`;
  const canWrite = isRead && props.onToggle !== undefined;
  const onToggle = props.onToggle;

  return (
    <li className="meridian-browser-policy__row">
      <Switch.Root
        className="meridian-browser-switch"
        aria-labelledby={labelId}
        checked={position}
        disabled={!canWrite}
        onCheckedChange={(nextEnabled) => {
          onToggle?.(props.switchId, nextEnabled);
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
      <div className="meridian-browser-policy__state">
        {props.reading.status === "unread" ? (
          <>
            <Nothing
              kind="not-checked"
              placement="inline"
              title="Not read"
              detail="The position shown is the enforcing one, not a reading."
            />
            <InlineRefusal
              code={props.reading.refusal.code}
              detail={props.reading.refusal.detail}
            />
          </>
        ) : null}
        {isRead && props.onToggle === undefined ? (
          <Nothing
            kind="not-checked"
            placement="inline"
            title="Read-only"
            detail="This node exposes no writer for the browser switches yet."
          />
        ) : null}
      </div>
    </li>
  );
}
