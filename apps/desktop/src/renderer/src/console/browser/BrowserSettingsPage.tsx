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
// size that could not be measured arrives as a refusal rather than as a zero. The one
// thing on the page that is not a projection is the clear control, which holds which
// step of its two-step act is in flight; it lives in its own module beside this one so
// that boundary is a file boundary rather than a promise.
//
// FOLD, NOT PAGINATE. 13.16: "Two switches and a table; the table folds past ten
// partitions." The fold is a native disclosure rather than a remembered flag — the
// page keeps no state, the control is keyboard-reachable and announced as
// expandable, and there is nothing to restore after a re-render.

import { BrowserPolicySettings, type BrowserPolicySettingsProps } from "./PolicySettings.js";
import { PartitionTable } from "./PartitionTable.js";
import type { BrowserPolicySwitchWriter } from "./policy-switches.js";
import type { BrowserPartitionListing } from "./site-partitions.js";
import type { SiteDataAct } from "./site-data-clear.js";

export interface BrowserSettingsPageProps {
  readonly switchReadings: BrowserPolicySettingsProps["readings"];
  readonly onToggleSwitch?: BrowserPolicySwitchWriter | undefined;
  readonly partitions: BrowserPartitionListing;
  /**
   * Clear one session's site data. Absent while no writer is registered, in which
   * case every row renders its scope and no confirm.
   *
   * It ANSWERS rather than returning nothing, because 13.16 orders the clear after a
   * pane close and an order only holds if the first step's outcome is readable.
   */
  readonly onClearSiteData?: SiteDataAct | undefined;
  /**
   * Close the browser pane still holding a partition open, so the clear beside it can
   * run. Absent while no close verb is registered, in which case a partition with an
   * open pane still offers the control and the control refuses by name.
   */
  readonly onClosePane?: SiteDataAct | undefined;
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
        <PartitionTable
          listing={props.partitions}
          onClearSiteData={props.onClearSiteData}
          onClosePane={props.onClosePane}
        />
      </section>
    </section>
  );
}
