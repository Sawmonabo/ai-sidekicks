// The composer's chip rail: where a message is going, and under what posture.
//
// Two chips, each a projection of daemon state the renderer never derives for
// itself. The rail owns their order and their accessible grouping and nothing else —
// each chip decides what it can honestly say from the model it is handed, including
// saying that it was told nothing.
//
// The order is deliberate: the target first, because it is the fact that changes what
// Send does, and the posture second, because it qualifies the run the target names.

import { type ComposerSeatProps } from "../../../console/seats/index.js";
import { useComposerAddress } from "../composer-address.js";
import { useAgentBindingReading } from "./agent-binding-read.js";
import { PostureChip } from "./PostureChip.js";
import { TargetChip } from "./TargetChip.js";

export function ComposerChipRail(props: ComposerSeatProps): React.JSX.Element {
  const address = useComposerAddress(props.sessionStore, props.focusedPane);
  // Armed HERE and not inside the chip: a read opened in a render body is a
  // subscription nothing commits or cleans up, and the rail is where this zone's
  // reads belong. The channel path names no agent, so nothing is asked and the chip
  // renders that as the absence it is.
  const binding = useAgentBindingReading(
    props.bridge,
    props.sessionStore.sessionId,
    address.target.path === "provider-bound" ? address.target.agentId : undefined,
  );
  return (
    <div className="meridian-composer__chips">
      <TargetChip model={address.targetChip} binding={binding} />
      <PostureChip model={address.postureChip} />
    </div>
  );
}
