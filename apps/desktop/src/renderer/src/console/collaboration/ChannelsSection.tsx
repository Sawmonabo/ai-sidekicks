// The sidebar's channels section: the mount, and nothing else.
//
// It resolves this session's models from the family's holder, subscribes to the
// channel read, and hands `ChannelList` plain values. Keeping the mount separate
// from the list is what lets the list be driven directly by a test with no bridge,
// no store, and no clock — the models are the only thing here that needs any of
// them.
//
// THE MODELS ARE NOT CONSTRUCTED IN THIS RENDER. The holder owns them and this
// component asks for them; a body that built a store would build a new one on every
// pass React discarded, and each one would leave a subscription behind it.

import { useMemo } from "react";

import type { SidebarSectionContext } from "../workspace/seats/index.js";
import { ChannelList } from "./ChannelList.js";
import { usePushDrivenRead } from "./push-driven-read.js";
import type { CollaborationSessionModelHolder } from "./session-models.js";

export interface ChannelsSectionProps {
  readonly context: SidebarSectionContext;
  readonly holder: CollaborationSessionModelHolder;
}

export function ChannelsSection(props: ChannelsSectionProps): React.JSX.Element {
  const { context, holder } = props;
  const models = useMemo(
    () => holder.modelsFor(context.bridge, context.sessionStore),
    [holder, context.bridge, context.sessionStore],
  );
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
