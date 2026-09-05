import { useCallback } from "react";
import { type SidebarSectionContext } from "../../seats/index.js";
import { useAttachmentCarrier } from "./attachment-carrier.js";

import { CarrierList } from "./CarrierList.js";
import { AttachmentCarrierSummary } from "./AttachmentCarrierSummary.js";

export interface AttachmentCarrierSectionProps {
  readonly context: SidebarSectionContext;
}

/** The picker's label, and the accessible name the control carries. */
const ATTACH_CONTROL_LABEL = "Attach a file";

export function AttachmentCarrierSection(props: AttachmentCarrierSectionProps): React.JSX.Element {
  const { bridge, sessionStore, isOpen } = props.context;
  const { snapshot, attachFiles, retry, abandon } = useAttachmentCarrier(
    bridge,
    sessionStore.sessionId,
  );

  const takeChosenFiles = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const chosen = event.target.files;
      if (chosen !== null) {
        attachFiles([...chosen]);
      }
      // The control is cleared so choosing the SAME file twice fires a change both
      // times. A picker that kept its value would leave the second choice silent,
      // which is the no-op rule 8 forbids — and a participant whose first attempt was
      // refused is exactly the person who chooses the same file again.
      event.target.value = "";
    },
    [attachFiles],
  );

  if (!isOpen) {
    return (
      <p className="meridian-attachment-section__summary">
        <AttachmentCarrierSummary entries={snapshot.entries} />
      </p>
    );
  }

  return (
    <div className="meridian-attachment-section">
      <label className="meridian-attachment-section__picker">
        <span>{ATTACH_CONTROL_LABEL}</span>
        <input type="file" multiple onChange={takeChosenFiles} />
      </label>
      <CarrierList
        entries={snapshot.entries}
        publishedAtMilliseconds={snapshot.publishedAtMilliseconds}
        onRetry={retry}
        onAbandon={abandon}
      />
    </div>
  );
}
