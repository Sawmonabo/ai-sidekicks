// The chapter-13.16 site-data table: four states, each rendering the fact that is true.
//
// Split out of `BrowserSettingsPage.tsx` so the page holds one component. The four
// arms are the whole of it — a refusal, a read in flight, an empty node, and the fold
// — and they are exhaustive rather than a happy path with a spinner, because a table
// that could not be read and a table with nothing in it are different facts and a
// person clearing site data has to be able to tell them apart.
//
// FOLD, NOT PAGINATE. 13.16: "the table folds past ten partitions." The fold is a
// native disclosure rather than a remembered flag — the control is keyboard-reachable
// and announced as expandable, and there is nothing to restore after a re-render.
//
// THE FOLD IS ALSO A REMOUNT BOUNDARY, and that is why the rounds arrive as a prop. A
// row that crosses it moves between two `<ul>`s, which React reconciles as an unmount
// and a mount despite the `key` — so a clear in flight has to be recorded above this
// table, never inside the row that is about to be rebuilt.

import { Nothing, formatCount } from "../../primitives/index.js";
import { PARTITION_FOLD_THRESHOLD } from "../../core/index.js";
import { PartitionRow } from "./PartitionRow.js";
import type { PartitionClearRounds } from "./partition-clear-rounds.js";
import type { BrowserPartitionListing } from "./site-partitions.js";
import type { SiteDataAct } from "./site-data-clear.js";

export interface PartitionTableProps {
  readonly listing: BrowserPartitionListing;
  /**
   * The page's record of running clears.
   *
   * Threaded through rather than held here, and that is the whole point of the fold
   * below: a row that moves between the two lists is remounted, so anything it holds
   * itself is lost mid-act.
   */
  readonly rounds: PartitionClearRounds;
  readonly onClearSiteData?: SiteDataAct | undefined;
  readonly onClosePane?: SiteDataAct | undefined;
}

export function PartitionTable(props: PartitionTableProps): React.JSX.Element {
  if (props.listing.kind === "refused") {
    return (
      <Nothing
        kind="error"
        placement="surface"
        title={props.listing.refusal.code}
        detail={props.listing.refusal.detail}
      />
    );
  }

  if (props.listing.kind === "reading") {
    return <Nothing kind="not-loaded" placement="surface" title="Reading stored site data" />;
  }

  if (props.listing.partitions.length === 0) {
    return (
      <Nothing
        kind="empty"
        placement="surface"
        title="No site data stored yet"
        detail="No browser pane on this node has written a cookie, a cache entry, or a storage record. There is nothing here to clear."
        action={
          <button type="button" className="meridian-browser-action" disabled>
            Clear site data
          </button>
        }
      />
    );
  }

  const shown = props.listing.partitions.slice(0, PARTITION_FOLD_THRESHOLD);
  const folded = props.listing.partitions.slice(PARTITION_FOLD_THRESHOLD);

  return (
    <>
      <ul className="meridian-browser-partitions">
        {shown.map((partition) => (
          <PartitionRow
            key={partition.sessionId}
            partition={partition}
            rounds={props.rounds}
            onClearSiteData={props.onClearSiteData}
            onClosePane={props.onClosePane}
          />
        ))}
      </ul>
      {folded.length === 0 ? null : (
        <details className="meridian-browser-disclosure">
          <summary>{`${formatCount(folded.length)} more`}</summary>
          <ul className="meridian-browser-partitions">
            {folded.map((partition) => (
              <PartitionRow
                key={partition.sessionId}
                partition={partition}
                rounds={props.rounds}
                onClearSiteData={props.onClearSiteData}
                onClosePane={props.onClosePane}
              />
            ))}
          </ul>
        </details>
      )}
    </>
  );
}
