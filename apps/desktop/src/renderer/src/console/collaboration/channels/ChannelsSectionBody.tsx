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

  return (
    <ChannelList
      state={state}
      openPane={context.openPane}
      activity={models.activity}
      labels={models.labels}
      isCatchingUp={isCatchingUp}
    />
  );
}
