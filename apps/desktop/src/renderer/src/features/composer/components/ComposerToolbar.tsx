// The composer's toolbar: the context ring, read from the session's standing events for the lead's
// addressed run, so it reports the lead's fullness however much of the log the window holds, never
// a child's. A composer addressed to the session and not to a run asks for no reading.

import { useMemo } from "react";
import type { ComposerProps } from "#renderer/registries/composer/registry.js";
import { newestContextWindowReading } from "#renderer/store/session/events/context-window-reading.js";
import { useSessionStore } from "#renderer/store/session/hooks/useOpenSessionStore.js";
import { selectStandingEvents } from "#renderer/store/session/selectors.js";
import { useComposerAddress } from "../hooks/useComposerAddress.js";
import { ComposerMeterStrip } from "./ComposerMeterStrip.js";

/** The composer's toolbar: how full the conversation is. */
export function ComposerToolbar(props: ComposerProps): React.JSX.Element {
  const standingEvents = useSessionStore(props.sessionStore, selectStandingEvents);
  const target = useComposerAddress(props.sessionStore);
  // Folded after the address, which is an input to the fold.
  const addressedRunId = target.kind === "run" ? target.targetRunId : undefined;
  const contextReading = useMemo(
    () => newestContextWindowReading(standingEvents, addressedRunId),
    [standingEvents, addressedRunId],
  );

  return <ComposerMeterStrip contextReading={contextReading} />;
}
