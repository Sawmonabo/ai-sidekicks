import { useCallback } from "react";

import { usePushDrivenRead, type SidebarSectionContext } from "../../seats/index.js";
import { useSessionDegraded } from "../../store/index.js";
import { ChannelList } from "./ChannelList.js";
import { type CollaborationSessionModels } from "../session-models.js";

/**
 * The body, mounted only once the models exist.
 *
 * A separate component because `usePushDrivenRead` needs a model to subscribe to and
 * a hook cannot be called conditionally — so the absence is rendered by the mount
 * above and the read is subscribed to here.
 */
export function ChannelsSectionBody(props: {
  readonly context: SidebarSectionContext;
  readonly models: CollaborationSessionModels;
}): React.JSX.Element {
  const { context, models } = props;
  const state = usePushDrivenRead(models.channelDirectory);
  // The store's own sticky degraded flag, read rather than inferred: the console
  // never decides on its own that a projection is behind. SUBSCRIBED rather than
  // sampled — a snapshot read in this body has nothing behind it, and this section
  // subscribes only to its channel read, so a store entering or leaving its degraded
  // state without that read settling moved the flag and re-rendered nothing.
  const isCatchingUp = useSessionDegraded(context.sessionStore);
  // The read's OWN re-open, not a rebuild of the set: a refused subscribe leaves this
  // column terminal for the life of the window, and the directory that refused is the
  // only one that has to be re-opened.
  const reopenDirectory = useCallback(() => {
    // ONE CALL, because the seam owns the stream-then-read order now: `refresh` takes
    // the subscription first where it is not held and requests the read either way.
    // A branch here would be a second reading of a decision the read already makes,
    // and the branch this replaced could only be right while both halves agreed.
    models.channelDirectory.refresh("participant-request");
  }, [models]);

  return (
    <ChannelList
      state={state}
      openPane={context.openPane}
      activity={models.activity}
      labels={models.labels}
      isCatchingUp={isCatchingUp}
      onReopen={reopenDirectory}
    />
  );
}
