import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { StandingContent } from "#renderer/components/LiveAnnouncer/StandingContent.js";
import { TryAgainButton } from "#renderer/components/TryAgainButton/TryAgainButton.js";
import { MountCard } from "./MountCard.js";
import { type OpenDiffSubject } from "./OpenDiffControl.js";
import { type RepoMountsReading } from "../reading.js";
import { type PlatformBridge } from "#renderer/services/platform/bridge.js";
import { type RepoOperations } from "../../operations.js";

/** What the mount list reads and the handlers it passes through to each card. */
export interface MountListProps {
  readonly reading: RepoMountsReading;
  /** Passed down to each card's controls, which take their clock from it. */
  readonly bridge: PlatformBridge;
  /** The calls each card's controls make. */
  readonly operations: RepoOperations;
  readonly onCopy: (canonicalRoot: string) => void;
  /** Read the section again after a user's own act. Passed through to each card. */
  readonly onRequestRead: () => void;
  /** Open a change set over one row's subject. Passed through to each card. */
  readonly onOpenDiff: (subject: OpenDiffSubject) => void;
}

/**
 * Every mount card for a reading, or the placeholder that says why there are none. What the first
 * read draws stands; a card's line that appears or changes after it is said.
 */
export function MountList(props: MountListProps): React.JSX.Element {
  return (
    <StandingContent isOpening={props.reading.readAtMilliseconds === 0}>
      {renderMounts(props)}
    </StandingContent>
  );
}

function renderMounts(props: MountListProps): React.JSX.Element {
  const { reading } = props;
  if (reading.mounts.length > 0) {
    return (
      <>
        {reading.mounts.map((mount) => (
          <MountCard
            key={mount.id}
            mount={mount}
            workspaces={reading.workspaces.filter((row) => row.repoMountId === mount.id)}
            bridge={props.bridge}
            operations={props.operations}
            onCopyCanonicalRoot={props.onCopy}
            onRequestRead={props.onRequestRead}
            onOpenDiff={props.onOpenDiff}
          />
        ))}
      </>
    );
  }
  switch (reading.status) {
    case "not-read":
    case "reading":
      return <Nothing kind="computing" placement="block" title="Loading…" />;
    case "read":
      // An answered read that found none is `empty`, never `not-checked`.
      return <Nothing kind="empty" placement="block" title="No repository attached" />;
    case "failed":
      return (
        <Nothing
          kind="error"
          placement="block"
          title="Couldn't load repositories"
          action={<TryAgainButton onPress={props.onRequestRead} />}
        />
      );
  }
}
