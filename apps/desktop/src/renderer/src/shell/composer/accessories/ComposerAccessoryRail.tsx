// The composer's trailing rail: the attachment strip and the context meter.
//
// WHERE THE FIGURE COMES FROM. The rail selects the session's timeline once and folds
// it to the newest context reading of the ADDRESSED RUN. The address is an input to
// the fold rather than a session-wide sweep: a session running two agents at once
// was showing one run's fullness beside a control pointed at the other. A composer
// addressed to the session and not to a run asks the fold for nothing.

import { useCallback, useMemo, useState } from "react";
import { useAttachmentCarrier } from "../../../console/repos/index.js";
import type {
  ComposerArtifactAttachment,
  ComposerSeatProps,
} from "../../../console/seats/index.js";
import {
  useSessionStore,
  type ConsoleSessionEvent,
  type SessionStoreState,
} from "../../../console/store/index.js";
import { useComposerAddress } from "../composer-address.js";
import { ComposerAttachmentBar } from "./attachments/ComposerAttachmentBar.js";
import { useAttachmentDropTarget } from "./attachments/use-attachment-drop.js";
import { ContextMeter } from "./context-meter/ContextMeter.js";
import { newestContextWindowReading } from "./usage-readings.js";

/**
 * The one selector, at module scope so its identity is stable across renders.
 *
 * It returns a STORED reference — the timeline array itself — which is what makes
 * the store's `Object.is` comparison a pointer check. A selector that mapped or
 * filtered here would rebuild an array every notification and re-render the rail on
 * every event in the session.
 */
const selectTimeline = (state: SessionStoreState): readonly ConsoleSessionEvent[] => state.timeline;

export interface ComposerAccessoryRailProps extends ComposerSeatProps {
  /**
   * The composer region, from the host that owns it.
   *
   * Drop and paste are bound to the WHOLE composer rather than to a strip inside it —
   * a target a person has to aim at is a target they miss — and the region is the
   * host's to hand out, exactly as it is for the discovery popover. Taking one here
   * rather than reaching for `closest()` keeps the rail out of the business of
   * recognising its own container by class name.
   */
  readonly region: React.RefObject<HTMLElement | null>;
}

/** The composer's trailing rail: what the message carries, and how full the conversation is. */
export function ComposerAccessoryRail(props: ComposerAccessoryRailProps): React.JSX.Element {
  const timeline = useSessionStore(props.sessionStore, selectTimeline);
  // One carrier per composer, opened on the session it is addressed within. The repos
  // family owns the ingest client's whole lifecycle behind this binding; the rail
  // holds no stream of its own and disposes nothing by hand.
  const attachmentCarrier = useAttachmentCarrier(props.bridge, props.sessionStore.sessionId);
  // Artifacts a view family put on this message. Held here rather than on the carrier
  // because they never went through this carrier: they were minted inside the owning
  // family's own pipeline and arrive already settled, so the ledger has nothing to
  // track for them and a fake entry would be a second source of ingest truth. Nothing
  // adds one until the attach control is built.
  const [familyAttachments, setFamilyAttachments] = useState<readonly ComposerArtifactAttachment[]>(
    [],
  );
  const forgetFamilyAttachment = useCallback((artifactId: string) => {
    setFamilyAttachments((held) => held.filter((candidate) => candidate.artifactId !== artifactId));
  }, []);
  const { attachFiles } = attachmentCarrier;
  const isDraggingFiles = useAttachmentDropTarget({
    region: props.region,
    onFilesChosen: attachFiles,
  });
  const address = useComposerAddress(props.sessionStore, props.focusedPane);
  // Folded AFTER the address, because the address is an input: the reading this
  // composer reports is the addressed run's own.
  const addressedRunId =
    address.target.path === "provider-bound" ? address.target.targetRunId : undefined;
  const contextReading = useMemo(
    () => newestContextWindowReading(timeline, addressedRunId),
    [timeline, addressedRunId],
  );

  return (
    <div className="meridian-composer__rail">
      {/* First in the rail, so what a message is carrying sits directly under the line
          it is being written on rather than below the meters. */}
      <ComposerAttachmentBar
        carrier={attachmentCarrier}
        familyAttachments={familyAttachments}
        onForgetFamilyAttachment={forgetFamilyAttachment}
        isDraggingFiles={isDraggingFiles}
      />
      <div className="meridian-composer__accessories">
        <div className="meridian-composer__meters">
          <ContextMeter reading={contextReading} />
        </div>
      </div>
    </div>
  );
}
