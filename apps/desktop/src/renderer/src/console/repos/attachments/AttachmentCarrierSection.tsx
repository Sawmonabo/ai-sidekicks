// The session sidebar's artifacts section — the one place a participant hands this
// session a file, and the ingest that follows it.
//
// WHY THIS FAMILY OWNS THIS SECTION. `seats/sidebar-sections.ts` says it in its own
// header: of the eight sections the sidebar draws, "repos and artifacts are the repos
// family's". This is the second of the two, filled from the same door as the first.
//
// WHY IT IS THE CARRIER AND NOT A SECOND ARTIFACT LIST. The completion leg of the
// ingest trio mints an ARTIFACT — `AttachmentIngestComplete` answers with an
// `artifactId`, a normalized name, and the type and size the daemon derived — so the
// act of adding a file to a session belongs beside the session's artifacts and
// nowhere else. What this session has already produced is the artifact pane's read,
// which is a different call with a different absence, and drawing a second copy of it
// here would be two surfaces answering one question.
//
// THE INGEST CLIENT'S OWN STATE VOCABULARY, AND NO SECOND PROGRESS MODEL. Every arm
// a row can be in — declared, ingesting, complete, refused, abandoned — is the
// ledger's, and the row itself is `AttachmentCard`, the same component the timeline's
// inline card mounts. A refusal renders through the card's own inline refusal
// carrying the daemon's code, and the retry it offers is the disposition the refusal
// carried rather than a control this file decided to show.
//
// THE PICKER IS AN INPUT AND NOT A DIALOG, because the file dialog is the host's:
// `<input type="file">` is the one affordance that opens it without this renderer
// asking main for anything, and the bytes it hands back are a `Blob` the ingest
// client slices a chunk at a time rather than a copy anything here holds.
//
// WHAT AN EMPTY CARRIER SAYS. `empty` and never `not-checked`: the carrier is the
// console's own record of what a participant handed over, so a carrier holding
// nothing is a question this surface can answer rather than one nobody put.

import { useCallback } from "react";

import { Nothing, formatCount } from "../../primitives/index.js";
import { type SidebarSectionContext } from "../../seats/index.js";
import { AttachmentCard } from "./AttachmentCard.js";
import { useAttachmentCarrier } from "./attachment-carrier.js";
import type { AttachmentIngestEntry } from "./attachment-shapes.js";

export interface AttachmentCarrierSectionProps {
  readonly context: SidebarSectionContext;
}

/** The picker's label, and the accessible name the control carries. */
const ATTACH_CONTROL_LABEL = "Attach a file";

/** What a carrier holding nothing says, in both shapes. */
const EMPTY_CARRIER_TITLE = "No file has been attached in this session.";

const EMPTY_CARRIER_DETAIL =
  "Attaching is deliberate — a file is read, sent in bounded chunks, and minted as an artifact only once the daemon has all of its bytes. What this session has already produced is the artifact pane's own read.";

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
        <CollapsedSummary entries={snapshot.entries} />
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

interface CarrierListProps {
  readonly entries: readonly AttachmentIngestEntry[];
  readonly publishedAtMilliseconds: number;
  readonly onRetry: (localId: string) => void;
  readonly onAbandon: (localId: string) => void;
}

/**
 * Every attachment this carrier holds, in the position the participant put it.
 *
 * A function returning JSX rather than a component of its own, on `RepoSection.tsx`'s
 * `renderCloneRows` precedent: the branch decides which of two things a settled
 * carrier has to say, which is a reading rather than a surface.
 */
function CarrierList(props: CarrierListProps): React.JSX.Element {
  if (props.entries.length === 0) {
    return (
      <Nothing
        kind="empty"
        placement="surface"
        title={EMPTY_CARRIER_TITLE}
        detail={EMPTY_CARRIER_DETAIL}
      />
    );
  }
  return (
    <>
      {props.entries.map((entry) => (
        <AttachmentCard
          key={entry.declared.localId}
          reading={{ kind: "ingesting", entry }}
          nowMilliseconds={props.publishedAtMilliseconds}
          onRetry={props.onRetry}
          onAbandon={props.onAbandon}
        />
      ))}
    </>
  );
}

/**
 * The collapsed line.
 *
 * A count of what the carrier holds rather than the section's name read back, on
 * `RepoSection.tsx`'s reason: the sidebar collapsed this section, so the one line of
 * room reports the fact that decision was made against.
 */
function CollapsedSummary(props: {
  readonly entries: readonly AttachmentIngestEntry[];
}): React.JSX.Element {
  const { entries } = props;
  if (entries.length === 0) {
    // The summary is a paragraph, so the absence takes its inline shape: a block-shaped
    // absence would put a `<div>` inside a `<p>`, which the parser closes early.
    return <Nothing kind="empty" placement="inline" title={EMPTY_CARRIER_TITLE} />;
  }
  const refusedCount = entries.filter((entry) => entry.state === "refused").length;
  return (
    <span className="meridian-attachment-section__count">
      {formatCount(entries.length)} attached
      {refusedCount > 0 ? `, ${formatCount(refusedCount)} refused` : ""}
    </span>
  );
}
