import { Nothing } from "../../primitives/index.js";
import { AttachmentCard } from "./AttachmentCard.js";
import { type AttachmentIngestEntry } from "./attachment-shapes.js";
import { EMPTY_CARRIER_TITLE, EMPTY_CARRIER_DETAIL } from "./attachment-carrier-copy.js";

/**
 * Every attachment this carrier holds, in the position the participant put it.
 *
 * A function returning JSX rather than a component of its own, on `RepoSection.tsx`'s
 * `renderCloneRows` precedent: the branch decides which of two things a settled
 * carrier has to say, which is a reading rather than a surface.
 */
export function CarrierList(props: CarrierListProps): React.JSX.Element {
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

export interface CarrierListProps {
  readonly entries: readonly AttachmentIngestEntry[];
  readonly publishedAtMilliseconds: number;
  readonly onRetry: (localId: string) => void;
  readonly onAbandon: (localId: string) => void;
}
