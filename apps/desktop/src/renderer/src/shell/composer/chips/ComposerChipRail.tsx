// The composer's chip rail: where a message is going, and under what posture.
//
// Two chips, each a projection of daemon state the renderer never derives for
// itself. The rail owns their order and their accessible grouping and nothing else —
// each chip decides what it can honestly say from the model it is handed, including
// saying that it was told nothing.
//
// The order is deliberate: the target first, because it is the fact that changes what
// Send does, and the posture second, because it qualifies the run the target names.

import { type ComposerSeatProps } from "../../../console/workspace/index.js";
import { useComposerAddress } from "../composer-address.js";
import { PostureChip } from "./PostureChip.js";
import { TargetChip } from "./TargetChip.js";

export function ComposerChipRail(props: ComposerSeatProps): React.JSX.Element {
  const address = useComposerAddress(props.sessionStore, props.focusedPane);
  return (
    <div className="meridian-composer__chips">
      <TargetChip model={address.targetChip} />
      <PostureChip model={address.postureChip} />
    </div>
  );
}
