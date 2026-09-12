// The target chip: where this message is going, in one line a person can read.
//
// It names the agent or channel this text goes to, states the binding in one clause,
// names the paying account, and marks a pending switch. Everything on it is a
// PROJECTION of what the daemon said — there is no field here the console computed and
// none it defaulted.
//
// THE FIVE FACTS COME FROM THREE PLACES, AND THE CHIP DOES NOT PRETEND OTHERWISE.
// The address and the binding clause are the session store's, folded from the event
// log. The paying account and a pending switch are the `agent.list` reply's, read
// through the growth port and joined with the account plane's labels in
// `agent-binding-read.ts`. A failed switch is the `agent.configUpdate` REPLY's, held
// by the mutation latch the rail arms and handed here on {@link TargetChipProps.axes}.
//
// THE AXIS POPOVER IS HERE NOW, AND WHAT CHANGED IS THE PORT. `agent.configUpdate` is
// still registered in no code package, but the growth port — the console's one seam
// for a wire it does not have — carries the operation, so a press reaches a call that
// the fixture answers and a live bridge refuses in type. What the chip still refuses
// to do is draw a control against nothing: `target-axis-reach.ts` settles that in the
// order it states, and a build whose port carries no such operation gets the sentence
// rather than the button, because a control that could silently do nothing is
// forbidden.
//
// AND ONE HALF OF THE FAILED SWITCH IS STILL UNREACHABLE. The DEFERRED arm rides
// `agent.provider_switch_failed`, an event type `packages/contracts`' union does not
// register, so no fold can carry it and the growth slate holds that debt. What is
// rendered below is the IMMEDIATE arm only — the reply to a mutation this window
// issued — which is why a participant on another machine watching the same agent sees
// no failure clause here.
//
// The absences are the `not-checked` kind rather than `empty` on purpose: nobody asked
// the daemon, and "we did not ask" is a different fact from "there are none".

import { Chip, Nothing } from "../../../console/primitives/index.js";
import type { AgentBindingReading } from "./agent-binding-read.js";
import { AxisSwitchRefusal } from "./AxisSwitchRefusal.js";
import { PayingAccount } from "./PayingAccount.js";
import { RosterReadRefusal } from "./RosterReadRefusal.js";
import { switchBoundarySentence } from "./switch-boundary.js";
import { TargetAxisPopover } from "./TargetAxisPopover.js";
import { failedSwitchOf, switchRefusalOf, type TargetAxisReach } from "./target-axis-reach.js";
import type { TargetChipModel } from "./chip-models.js";

/** The glyph each path wears, so the two are distinguishable without reading. */
const PATH_GLYPH = { "channel-message": "channel", "provider-bound": "agent" } as const;

export interface TargetChipProps {
  readonly model: TargetChipModel;
  /**
   * What the binding reads said, or why they said nothing.
   *
   * Handed in rather than read here: a component that opened a wire read would be a
   * subscription in a render body, and the rail is where the composer's reads are
   * armed. The channel path carries the `not-checked` reading, which is the honest
   * one — no agent is addressed, so no roster was asked for.
   */
  readonly binding: AgentBindingReading;
  /**
   * What may be done about this agent's provider axes, or nothing at all.
   *
   * Absent on the channel path, which addresses no agent and therefore has no axes —
   * a different state from the three {@link TargetAxisReach} arms, each of which is
   * about an agent that IS addressed. Resolved by the rail, because the two seams it
   * carries are reads and latches the rail owns.
   */
  readonly axes?: TargetAxisReach | undefined;
}

export function TargetChip(props: TargetChipProps): React.JSX.Element {
  const { target } = props.model;
  const isProviderBound = target.path === "provider-bound";
  const failedSwitch = failedSwitchOf(props.axes);
  const switchRefusal = switchRefusalOf(props.axes);
  return (
    <div
      className="meridian-composer__target"
      // A group rather than a bare span: the chip is several facts about one
      // address, and a screen reader that met them as loose text would read the
      // binding clause as if it were the next control's label.
      role="group"
      aria-label="Message target"
    >
      <Chip
        glyph={PATH_GLYPH[target.path]}
        tone={isProviderBound ? "accent" : "neutral"}
        label={targetName(props.model)}
      />
      {isProviderBound && target.runState !== undefined ? (
        <Chip mono label={target.runState} />
      ) : null}
      {props.model.bindingClause === undefined ? (
        <Nothing
          kind="not-checked"
          title="Binding not read"
          detail="The provider, model, and effort this agent is bound to have not been read from the daemon, so the console shows none rather than a default it chose."
        />
      ) : (
        <Chip mono label={props.model.bindingClause} />
      )}
      {isProviderBound ? <PayingAccount binding={props.binding} /> : null}
      {props.binding.pendingSwitch === undefined ? null : (
        <Chip
          tone="attention"
          glyph="clock"
          label={switchBoundarySentence(props.binding.pendingSwitch.appliesAt)}
        />
      )}
      {/* Two chips and not one, because they are two kinds of statement. The first is
          the console's own sentence about what happened; the second is the reason the
          wire gave, verbatim and in mono, because a reason paraphrased into prose is a
          reason this console invented (rule 4). A reply that failed and named nothing
          gets the first alone rather than an empty figure. */}
      {failedSwitch === undefined ? null : (
        <>
          <Chip tone="failure" glyph="alert" label="Switch failed" />
          {failedSwitch.reason === undefined ? null : (
            <Chip tone="failure" mono label={failedSwitch.reason} />
          )}
        </>
      )}
      {/* The mutation's own refusal, beside the settlement rather than instead of it:
          a call that did not land and a daemon that answered "failed" are two facts,
          and each is unreachable from the other. It lives HERE rather than only on the
          form because the form is portalled and unmounts on a dismissal, and a
          participant who pressed Apply and clicked away would otherwise be told
          nothing at all. */}
      {switchRefusal === undefined ? null : <AxisSwitchRefusal refusal={switchRefusal} />}
      {renderAxisAffordance(props.axes)}
    </div>
  );
}

/** What is absent, worded once so every arm below says the same thing is missing. */
const AXIS_CHANGE_NOT_OFFERED = "Axis change not offered";

/**
 * What the chip offers — or says instead — about changing this agent's axes.
 *
 * A total function over the union, so each arm's sentence is written exactly once.
 * No absence arm draws a disabled control: a disabled button asserts that the act
 * exists and is momentarily unavailable, and none of these states is that.
 *
 * FOUR OF THE SIX ARMS ARE THE ROSTER READING'S OWN PHASES, and they are four
 * sentences because they are four facts. One arm carried all of them and said the
 * roster row "has not been read" — false for a read that refused, false for one still
 * travelling, and false for a roster that served and holds no such agent. The refused
 * one additionally dropped the daemon's reason on the floor.
 */
function renderAxisAffordance(axes: TargetAxisReach | undefined): React.ReactNode {
  if (axes === undefined) {
    return null;
  }
  if (axes.reach === "unreachable") {
    return (
      <Nothing
        kind="not-checked"
        title={AXIS_CHANGE_NOT_OFFERED}
        detail="This build carries no operation that moves an agent's provider axes, so there is no control here that would reach one."
      />
    );
  }
  if (axes.reach === "refused") {
    // The same three arms the paying-account chip renders off this same read, from
    // the one module that owns them: an unbuilt wire is not an error, and a refusal
    // that carried no reason is still a refusal.
    return (
      <RosterReadRefusal
        title={AXIS_CHANGE_NOT_OFFERED}
        noReasonDetail="The agent roster read refused and carried no reason, so there is no binding to offer a change from."
        refusal={axes.refusal}
      />
    );
  }
  if (axes.reach === "loading") {
    return (
      <Nothing
        kind="not-loaded"
        title="Reading this agent's axes"
        detail="The agent roster read is still travelling, so there is nothing yet to offer a change from."
      />
    );
  }
  if (axes.reach === "not-checked") {
    return (
      <Nothing
        kind="not-checked"
        title="Axes not read"
        detail="Nothing has asked the daemon what this agent is bound to, so the console cannot offer a change from it."
      />
    );
  }
  if (axes.reach === "no-such-agent") {
    // Its own words and not {@link AXIS_CHANGE_NOT_OFFERED}: a badge carries its
    // detail as a tooltip, so two arms sharing a title are two facts a reader meets
    // as one — which is the collapse rule 8 forbids, one layer down from the union.
    return (
      <Nothing
        kind="empty"
        title="Agent not on the roster"
        detail="The agent roster was read and holds no row for this agent, so there is no binding to move."
      />
    );
  }
  return <TargetAxisPopover control={axes.control} />;
}

/**
 * What the chip calls the target.
 *
 * Never an opaque id: an id in a chip is an internal handle a person cannot act on.
 * An unnamed agent or channel is described rather than identified, and the state
 * chip beside it is what carries the wire-verbatim fact.
 *
 * THE CHANNEL ARM BRANCHES ON THE ID BEFORE THE LABEL, which is the whole of this
 * function's correctness. A pane addressed at a channel whose label the store has
 * not read fell through `?? "This session"` — the words the UNADDRESSED arm uses,
 * and the unaddressed arm omits `channelId` entirely. So two different destinations
 * rendered identically and the chip named the one that was not happening. An
 * addressed channel with no label is a channel whose label was not read, which is
 * the console's own `not-checked` fact rather than "there is no channel".
 */
function targetName(model: TargetChipModel): string {
  const { target } = model;
  if (target.path === "provider-bound") {
    return target.agentName ?? "This agent's running turn";
  }
  if (target.channelLabel !== undefined) {
    return target.channelLabel;
  }
  return target.channelId === undefined ? "This session" : "This channel, name not read";
}
