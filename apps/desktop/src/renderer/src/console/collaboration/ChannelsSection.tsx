// The sidebar's channels section: the mount, and nothing else.
//
// It leases this session's models from the family's holder, subscribes to the
// channel read, and hands `ChannelList` plain values. Keeping the mount separate
// from the list is what lets the list be driven directly by a test with no bridge,
// no store, and no clock — the models are the only thing here that needs any of
// them.
//
// THE MODELS ARE NOT ACQUIRED IN THIS RENDER. The holder owns them and a mount
// effect leases them; a body that built a store would build a new one on every pass
// React discarded, and each one would leave a subscription behind it. The frame
// between the first render and that effect is a read in flight, and it renders as
// the `not-loaded` kind of nothing rather than as an empty channel list.

import { usePushDrivenRead, type SidebarSectionContext } from "../seats/index.js";
import { Nothing } from "../primitives/index.js";
import { ChannelList } from "./ChannelList.js";
import {
  useSessionModels,
  type CollaborationSessionModelHolder,
  type CollaborationSessionModels,
} from "./session-models.js";

export interface ChannelsSectionProps {
  readonly context: SidebarSectionContext;
  readonly holder: CollaborationSessionModelHolder;
}

export function ChannelsSection(props: ChannelsSectionProps): React.JSX.Element {
  const { context, holder } = props;
  const models = useSessionModels(holder, context.bridge, context.sessionStore);
  if (models === undefined) {
    return (
      <Nothing kind="not-loaded" placement="surface" title="Opening this session's channels." />
    );
  }
  return <ChannelsSectionBody context={context} models={models} />;
}

/**
 * The body, mounted only once the models exist.
 *
 * A separate component because `usePushDrivenRead` needs a model to subscribe to and
 * a hook cannot be called conditionally — so the absence is rendered by the mount
 * above and the read is subscribed to here.
 */
function ChannelsSectionBody(props: {
  readonly context: SidebarSectionContext;
  readonly models: CollaborationSessionModels;
}): React.JSX.Element {
  const { context, models } = props;
  const state = usePushDrivenRead(models.channelDirectory);

  return (
    <ChannelList
      state={state}
      openPane={context.openPane}
      activity={models.activity}
      labels={models.labels}
      // The store's own sticky degraded flag, read rather than inferred: the console
      // never decides on its own that a projection is behind.
      isCatchingUp={context.sessionStore.snapshot().degradedCause !== undefined}
    />
  );
}
