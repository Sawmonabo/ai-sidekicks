// The seat a file is chosen on: the picker, what this deployment will accept, and
// where the carrier stands against the two bounds a participant can walk into.
//
// THE PICKER SAYS WHAT IT ACCEPTS. It used to be a bare file input beside a list, with
// the allow-list and all four bounds complete on the artifact pane's own disclosure —
// a different surface, one click away, that a person choosing a file has no reason to
// have opened. `Spec-014 §Bounds (normative defaults; operator-tunable)` puts the hint
// on the picker, so `AttachmentBoundsDisclosure` renders here and on the pane, from one
// component.
//
// NO `accept` ATTRIBUTE, AND THAT IS DELIBERATE. The hint is a convenience and never
// the gate: an operator override replaces the allow-list wholesale, so a client-side
// filter would make the console wrong about a deployment it cannot see and would hide
// files the daemon would have taken. The same rule is why the count line below carries
// a denominator and no disabled state.

import { useCallback } from "react";

import { type SidebarSectionContext } from "../../seats/index.js";
import { AttachmentBoundsDisclosure } from "./AttachmentBoundsDisclosure.js";
import { SHIPPED_DEFAULT_ALLOWLIST } from "./attachment-bounds.js";
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
  const { snapshot, attachFiles, retry, abandon, reorder } = useAttachmentCarrier(
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

  // THE SHIPPED DEFAULT, NAMED AS SUCH. `bridge/growth-port/growth-port.ts` refuses
  // `artifactAllowlistRead` by name, so no build the console runs on today can answer
  // with a deployment's effective list; `attachment-bounds.ts` says why the affordance
  // does not mint a second scheduled reading to be told that again. The disclosure
  // reports which of the two lists a participant is looking at either way.
  return (
    <div className="meridian-attachment-section">
      <label className="meridian-attachment-section__picker">
        <span>{ATTACH_CONTROL_LABEL}</span>
        <input type="file" multiple onChange={takeChosenFiles} />
      </label>
      {/* The same count the collapsed line carries, in the section's own padding: the
          summary class inset matches the sidebar's gutter and would double it here. */}
      <p className="meridian-attachment-section__fill">
        <AttachmentCarrierSummary entries={snapshot.entries} />
      </p>
      <AttachmentBoundsDisclosure allowlist={SHIPPED_DEFAULT_ALLOWLIST} />
      <CarrierList
        entries={snapshot.entries}
        publishedAtMilliseconds={snapshot.publishedAtMilliseconds}
        maximumByteLength={SHIPPED_DEFAULT_ALLOWLIST.maximumByteLength}
        onRetry={retry}
        onAbandon={abandon}
        onReorder={reorder}
      />
    </div>
  );
}
