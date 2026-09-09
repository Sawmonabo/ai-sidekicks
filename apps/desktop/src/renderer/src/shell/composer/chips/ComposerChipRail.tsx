// The composer's chip rail: where a message is going, and under what posture.
//
// Two chips, each a projection of daemon state the renderer never derives for
// itself. The rail owns their order and their accessible grouping and nothing else —
// each chip decides what it can honestly say from the model it is handed, including
// saying that it was told nothing.
//
// The order is deliberate: the target first, because it is the fact that changes what
// Send does, and the posture second, because it qualifies the run the target names.
//
// AND THE RAIL OWNS THE ZONE'S READS AND ITS ONE LATCH. Three seams are armed here
// and handed down: the addressed agent's roster reading, the node's driver catalog,
// and the `agent.configUpdate` latch the axis popover submits through. All three are
// armed unconditionally, because a hook may not be called conditionally, and each one
// is honest about being addressed at nothing — the roster reading answers
// `not-checked` for a composer that names no agent, and the latch submits nothing
// rather than inventing an id to move.
//
// THE TWO FAMILIES' COMPOSITIONS ARE THE AGENTS FAMILY'S, TAKEN THROUGH ITS DOOR. The
// catalog reading and the latch are `provider-switch-host.ts`'s factories, not
// rebuilt here: what a second host would otherwise copy is the read, the scheduler,
// the generation round, and the origin string a refusal is named by, and the copy
// that drifts is the one nobody diffs.
//
// A SETTLEMENT IS THE FIFTH REASON TO RE-READ THE BINDING, and it is passed down
// rather than acted on here. The four standing reasons are the store's; this one is
// "a mutation this window issued was answered", which no event announces to the
// client that issued it and which is exactly when the chip's pending-switch clause
// has to move. It is handed to the reading for EVERY arm rather than for the two that
// changed something: a failed switch is the daemon's word that the binding did not
// move, and confirming that costs one read and removes the only path by which this
// chip could show a pending intent the daemon has already settled.

import { type ComposerSeatProps } from "../../../console/seats/index.js";
import { useAgentBindingSwitch, useDriverCatalogReading } from "../../../console/agents/index.js";
import { useComposerAddress } from "../composer-address.js";
import { useAgentBindingReading } from "./agent-binding-read.js";
import { PostureChip } from "./PostureChip.js";
import { resolveTargetAxisReach } from "./target-axis-reach.js";
import { TargetChip } from "./TargetChip.js";

export function ComposerChipRail(props: ComposerSeatProps): React.JSX.Element {
  const address = useComposerAddress(props.sessionStore, props.focusedPane);
  // The channel path names no agent, so nothing is asked of the roster and the chip
  // renders that as the absence it is.
  const addressedAgentId =
    address.target.path === "provider-bound" ? address.target.agentId : undefined;
  const switching = useAgentBindingSwitch(
    props.bridge,
    props.sessionStore.sessionId,
    addressedAgentId,
  );
  // Armed HERE and not inside the chip: a read opened in a render body is a
  // subscription nothing commits or cleans up, and the rail is where this zone's
  // reads belong.
  const binding = useAgentBindingReading(
    props.bridge,
    props.sessionStore,
    addressedAgentId,
    switching.settled,
  );
  const catalog = useDriverCatalogReading(props.bridge);
  const axes = resolveTargetAxisReach(props.bridge, binding, catalog, switching);
  return (
    <div className="meridian-composer__chips">
      <TargetChip
        model={address.targetChip}
        binding={binding}
        axes={addressedAgentId === undefined ? undefined : axes}
      />
      <PostureChip model={address.postureChip} />
    </div>
  );
}
