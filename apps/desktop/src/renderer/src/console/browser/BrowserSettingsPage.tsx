// Chapter 13.16 — the whole of the browser in settings.
//
// `Spec-023 §Console Design (Meridian)` 13.16 fixes the contents exactly: the file
// boundary switch, the page tools switch, and "the per-session site-data partitions
// this node holds, with their sizes in mono, and a clear-site-data control per
// partition that closes the pane first". Nothing else about the browser is placed
// here, and no policy row is placed anywhere else.
//
// WHERE THIS PAGE IS MOUNTED, AND WHY IT IS NOT MOUNTED YET. The console's surface
// registry is keyed by SLOT, and `settings` is one slot for the whole of chapter 13
// — sixteen-odd pages, of which this is one. There is no settings-page registry in
// the tree, so this page claims no slot: claiming `settings` for the browser alone
// would take the surface every other chapter-13 page needs. It is composed by
// whichever task mints that registry, and until then it is reached by its own test.
// The alternative — inventing the registry here — would be a shared spine minted by
// a family that does not own it.
//
// THE PARTITION TABLE IS A PROJECTION, NOT A READ. Every figure on it arrives as a
// prop: this page performs no fetch, holds no store, and runs no effect. That is
// what keeps it renderable in a test, in a screenshot tier, and in an auxiliary
// window without a second code path — and it is why the sizes can be honest, since a
// size that could not be measured arrives as a refusal rather than as a zero.
//
// FOLD, NOT PAGINATE. 13.16: "Two switches and a table; the table folds past ten
// partitions." The fold is a native disclosure rather than a remembered flag — the
// page keeps no state, the control is keyboard-reachable and announced as
// expandable, and there is nothing to restore after a re-render.

import {
  BrowserPolicySettings,
  type BrowserPolicySettingsProps,
  type BrowserPolicySwitchId,
} from "./PolicySettings.js";
import type { ConsoleRefusal } from "../core/index.js";
import {
  Chip,
  InlineRefusal,
  Nothing,
  WireFigure,
  formatByteQuantity,
  formatCount,
} from "../primitives/index.js";

/**
 * Partitions rendered before the table folds.
 *
 * 13.16 fixes the number, and it is spent here rather than in `core/constants.ts`
 * because that module's own rule is that "each view family adds its own bound beside
 * its subtree, so a bound always sits next to the code that spends it". Ten is the
 * point past which a table stops being read and starts being scanned; a node holding
 * more sessions than that has a list, not a table.
 */
const PARTITION_FOLD_THRESHOLD = 10;

/** A stored size, or why it could not be measured. Never a zero standing in for either. */
export type BrowserPartitionSize =
  | { readonly status: "measured"; readonly byteLength: number }
  | { readonly status: "unmeasured"; readonly refusal: ConsoleRefusal };

export interface BrowserSitePartition {
  /** The owning session, wire-verbatim. */
  readonly sessionId: string;
  /** The session's title, as the console shows it elsewhere. */
  readonly sessionTitle: string;
  readonly size: BrowserPartitionSize;
  /**
   * True while a browser pane in that session still holds the partition open.
   * Daemon-supplied: 13.16 forbids clearing under an open pane, and a renderer that
   * decided this for itself would be a second source of truth for pane liveness.
   */
  readonly hasOpenPane: boolean;
  /** A clear that failed, rendered on its own row rather than as a page banner. */
  readonly lastClearRefusal?: ConsoleRefusal | undefined;
}

/** What the node said about its partitions, or why it said nothing. */
export type BrowserPartitionListing =
  | { readonly status: "not-read"; readonly refusal: ConsoleRefusal }
  | { readonly status: "reading" }
  | { readonly status: "read"; readonly partitions: readonly BrowserSitePartition[] };

export interface BrowserSettingsPageProps {
  readonly switchReadings: BrowserPolicySettingsProps["readings"];
  readonly onToggleSwitch?:
    | ((switchId: BrowserPolicySwitchId, nextEnabled: boolean) => void)
    | undefined;
  readonly partitions: BrowserPartitionListing;
  /**
   * Clear one session's site data. Absent while no writer is registered, in which
   * case every row renders its scope and no confirm.
   */
  readonly onClearSiteData?: ((sessionId: string) => void) | undefined;
}

export function BrowserSettingsPage(props: BrowserSettingsPageProps): React.JSX.Element {
  return (
    <section
      className="meridian-browser-settings"
      aria-labelledby="meridian-browser-settings-title"
    >
      <header>
        <h2 className="meridian-browser-settings__title" id="meridian-browser-settings-title">
          Browser
        </h2>
        <p className="meridian-browser-settings__lede">
          Two switches this node&rsquo;s browser panes read before they act, and the site data those
          panes have stored.
        </p>
      </header>

      <section className="meridian-browser-settings__section" aria-label="Browser policy">
        <h3 className="meridian-browser-settings__section-title">Policy</h3>
        <BrowserPolicySettings readings={props.switchReadings} onToggle={props.onToggleSwitch} />
      </section>

      <section className="meridian-browser-settings__section" aria-label="Stored site data">
        <h3 className="meridian-browser-settings__section-title">Site data</h3>
        <PartitionTable listing={props.partitions} onClearSiteData={props.onClearSiteData} />
      </section>
    </section>
  );
}

interface PartitionTableProps {
  readonly listing: BrowserPartitionListing;
  readonly onClearSiteData: BrowserSettingsPageProps["onClearSiteData"];
}

/**
 * The four states of the partition list, each rendering the fact that is true.
 *
 * Not exported: it is this page's own composition, and a partition table mounted
 * anywhere else would be site-data policy outside chapter 13.
 */
function PartitionTable(props: PartitionTableProps): React.JSX.Element {
  if (props.listing.status === "not-read") {
    return (
      <Nothing
        kind="error"
        placement="surface"
        title={props.listing.refusal.code}
        detail={props.listing.refusal.detail}
      />
    );
  }

  if (props.listing.status === "reading") {
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
            onClearSiteData={props.onClearSiteData}
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
                onClearSiteData={props.onClearSiteData}
              />
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

interface PartitionRowProps {
  readonly partition: BrowserSitePartition;
  readonly onClearSiteData: BrowserSettingsPageProps["onClearSiteData"];
}

/**
 * One partition: who owns it, how large it is, and the armed control that says what
 * clearing it takes away before it will take it.
 */
function PartitionRow(props: PartitionRowProps): React.JSX.Element {
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
      <div className="meridian-browser-partitions__control">
        {partition.hasOpenPane ? (
          <Chip tone="attention" glyph="alert" label="A pane still has this partition open" />
        ) : (
          <details className="meridian-browser-arm">
            <summary>Clear site data</summary>
            <div className="meridian-browser-arm__body">
              <p className="meridian-browser-arm__scope">
                Removes every cookie, cache entry, and storage record this session&rsquo;s browser
                panes wrote, and deletes the profile directory holding them. It reaches nothing
                outside this session, and it is a filesystem removal rather than a cryptographic
                erase.
              </p>
              {props.onClearSiteData === undefined ? (
                <Nothing
                  kind="not-checked"
                  placement="inline"
                  title="No writer registered"
                  detail="This node exposes no site-data reset yet, so there is nothing to confirm."
                />
              ) : (
                <button
                  type="button"
                  className="meridian-browser-action"
                  onClick={() => {
                    props.onClearSiteData?.(partition.sessionId);
                  }}
                >
                  Clear this session&rsquo;s site data
                </button>
              )}
            </div>
          </details>
        )}
        {partition.lastClearRefusal === undefined ? null : (
          <InlineRefusal
            code={partition.lastClearRefusal.code}
            detail={partition.lastClearRefusal.detail}
          />
        )}
      </div>
    </li>
  );
}
