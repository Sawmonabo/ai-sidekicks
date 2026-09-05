// One row of the chapter-13.16 site-data table.
//
// Split out of `BrowserSettingsPage.tsx` so the page holds one component: the row is
// the only place a partition's three facts — whose it is, how large it is, and what
// clearing it takes away — are put beside each other, and a second table anywhere
// would be site-data policy stated twice.
//
// THE SIZE IS RENDERED TWICE ON PURPOSE. The visible figure is the rounded quantity a
// person reads; its `title` is the exact byte count, so a partition that rounds to the
// same text as its neighbour is still distinguishable without the row growing a column.

import { InlineRefusal, WireFigure, formatByteQuantity } from "../primitives/index.js";
import { PartitionClearControl } from "./PartitionClearControl.js";
import type { PartitionClearRounds } from "./partition-clear-rounds.js";
import type { BrowserSitePartition } from "./site-partitions.js";
import type { SiteDataAct } from "./site-data-clear.js";

export interface PartitionRowProps {
  readonly partition: BrowserSitePartition;
  /** The page's record of running clears, threaded past the row that may be remounted. */
  readonly rounds: PartitionClearRounds;
  readonly onClearSiteData?: SiteDataAct | undefined;
  readonly onClosePane?: SiteDataAct | undefined;
}

/**
 * One partition: who owns it, how large it is, and the armed control that says what
 * clearing it takes away before it will take it.
 */
export function PartitionRow(props: PartitionRowProps): React.JSX.Element {
  const { partition } = props;

  return (
    <li className="meridian-browser-partitions__row">
      <div className="meridian-browser-partitions__identity">
        <span className="meridian-browser-partitions__title">{partition.sessionTitle}</span>
        <WireFigure value={partition.sessionId} />
      </div>
      <div className="meridian-browser-partitions__size">
        {partition.size.status === "measured" ? (
          <WireFigure
            value={formatByteQuantity(partition.size.byteLength).text}
            title={String(partition.size.byteLength)}
          />
        ) : (
          <InlineRefusal
            code={partition.size.refusal.code}
            detail={partition.size.refusal.detail}
          />
        )}
      </div>
      <PartitionClearControl
        rounds={props.rounds}
        sessionId={partition.sessionId}
        hasOpenPane={partition.hasOpenPane}
        lastClearRefusal={partition.lastClearRefusal}
        onClosePane={props.onClosePane}
        onClearSiteData={props.onClearSiteData}
      />
    </li>
  );
}
