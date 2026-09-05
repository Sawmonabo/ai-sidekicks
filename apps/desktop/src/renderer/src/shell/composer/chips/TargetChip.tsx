// The target chip: where this message is going, in one line a person can read.
//
// `Spec-023 §Console Design (Meridian)` §Target chip: it names the agent or channel
// this text goes to, states the binding in one clause, names the paying account, and
// marks a pending switch. Everything on it is a PROJECTION of what the daemon said —
// there is no field here the console computed and none it defaulted.
//
// THE FOUR FACTS COME FROM THREE PLACES, AND THE CHIP DOES NOT PRETEND OTHERWISE.
// The address and the binding clause are the session store's, folded from the event
// log. The paying account and a pending switch are the `agent.list` reply's, read
// through the growth port and joined with the account plane's labels in
// `agent-binding-read.ts`. A failed switch has no carrier this console can reach —
// that module says which two it would come from and why neither is reachable — so
// nothing here renders one.
//
// WHY THE AXIS POPOVER IS NOT HERE. The design gives the chip a popover that changes
// the agent's five provider axes through `agent.configUpdate`. That method is not
// registered anywhere in `packages/contracts`, and the growth port — the console's
// one seam for a wire it does not have — carries no operation for it either. Offering
// a control that could reach neither would be a control that silently does nothing,
// which is the one outcome a mutation surface may not have. So the chip renders the
// axes it has been TOLD and says plainly that changing them is not reachable here
// yet, which is the honest shape of the same sentence.
//
// The absence is the `not-checked` kind rather than `empty` on purpose: nobody asked
// the daemon for these axes, and "we did not ask" is a different fact from "there
// are none" (`Spec-023 §Console Design (Meridian)` rule 8).

import { Chip, Nothing } from "../../../console/primitives/index.js";
import type { AgentBindingReading } from "./agent-binding-read.js";
import { PayingAccount } from "./PayingAccount.js";
import { switchBoundarySentence } from "./switch-boundary.js";
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
}

export function TargetChip(props: TargetChipProps): React.JSX.Element {
  const { target } = props.model;
  const isProviderBound = target.path === "provider-bound";
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
    </div>
  );
}

/**
 * What the chip calls the target.
 *
 * Never an opaque id: an id in a chip is an internal handle a person cannot act on.
 * An unnamed agent or channel is described rather than identified, and the state
 * chip beside it is what carries the wire-verbatim fact.
 */
function targetName(model: TargetChipModel): string {
  const { target } = model;
  if (target.path === "provider-bound") {
    return target.agentName ?? "This agent's running turn";
  }
  return target.channelLabel ?? "This session";
}
