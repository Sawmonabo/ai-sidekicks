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

import { type SidebarSectionContext } from "../../seats/index.js";
import { Nothing } from "../../primitives/index.js";
import { useSessionModels, type CollaborationSessionModelHolder } from "../session-models.js";
import { ChannelsSectionBody } from "./ChannelsSectionBody.js";

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
