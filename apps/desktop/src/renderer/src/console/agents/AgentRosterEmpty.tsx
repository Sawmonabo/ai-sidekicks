// What an empty agent roster says: the one action there is, and nothing else.
//
// Its own module rather than a second export on the card, per this package's
// one-component rule: the card renders an agent and this renders the absence of
// every agent, and a surface mounts exactly one of them.

import { Nothing } from "../primitives/index.js";

/** What an empty roster says: the one action there is, and nothing else. */
export function AgentRosterEmpty(props: {
  readonly onAttach?: (() => void) | undefined;
}): React.JSX.Element {
  return (
    <Nothing
      kind="empty"
      placement="surface"
      title="No agent is attached to this session."
      detail="Attaching one puts a configured sidekick into the session under a binding you choose or a definition supplies."
      action={
        props.onAttach === undefined ? undefined : (
          <button type="button" className="meridian-agent-card__action" onClick={props.onAttach}>
            Attach a sidekick
          </button>
        )
      }
    />
  );
}
