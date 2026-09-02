// The composer's chip rail — reserved, not stubbed.
//
// The rail is where the composer says WHERE a message is going and UNDER WHAT
// POSTURE it will run: the target chip and the posture chip, each a projection of
// daemon state that the renderer never derives for itself. Both are the send
// router's siblings and land with it.
//
// Nothing here fabricates either chip. A chip drawn from a guess would be the one
// failure this surface cannot afford — a person reading "session" while the send
// resolves to an agent, or a posture chip that says what the daemon has not said.
// So the rail holds its place and says so.

import { Nothing } from "../../../console/primitives/index.js";

export function ComposerChipRail(): React.JSX.Element {
  return (
    <div className="meridian-composer__chips">
      <Nothing
        kind="not-checked"
        title="The composer has not been told where this message goes."
        detail="The target and the execution posture are projections of daemon state, and both arrive with the send router."
      />
    </div>
  );
}
