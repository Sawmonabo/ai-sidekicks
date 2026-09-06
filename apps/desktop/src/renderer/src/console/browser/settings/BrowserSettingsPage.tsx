// Chapter 13.16 — the whole of the browser in settings.
//
// `Spec-023 §Console Design (Meridian)` 13.16 fixes the contents exactly: the file
// boundary switch, the page tools switch, and "the per-session site-data partitions
// this node holds, with their sizes in mono, and a clear-site-data control per
// partition that closes the pane first". Nothing else about the browser is placed
// here, and no policy row is placed anywhere else.
//
// WHERE THIS PAGE IS MOUNTED. On the settings board, as the `browser` section. The
// console's surface registry is keyed by SLOT and `settings` is one slot for the whole
// of chapter 13, so the pages behind it are keyed by SECTION in a registry of their
// own — and this page claims no slot for exactly that reason: claiming `settings` for
// the browser alone would take the surface every other chapter-13 page needs. The one
// line that registers it lives at the console ROOT, in `console/browser-settings-page.ts`,
// because the registration names two view families and neither family may name the
// other. Its reads are `browser-settings-source.ts` beside this file, bound by
// `BrowserSettingsSection.tsx`, so nothing below changes: this page still fetches
// nothing.
//
// THE PARTITION TABLE IS A PROJECTION, NOT A READ. Every figure on it arrives as a
// prop: this page performs no fetch, holds no store, and runs no effect. That is
// what keeps it renderable in a test, in a screenshot tier, and in an auxiliary
// window without a second code path — and it is why the sizes can be honest, since a
// size that could not be measured arrives as a refusal rather than as a zero. The one
// thing on the page that is not a projection is the clear act, whose two-step progress
// and verdict live in `partition-clear-rounds.ts` beside this file, so that boundary is
// a file boundary rather than a promise.
//
// FOLD, NOT PAGINATE. 13.16: "Two switches and a table; the table folds past ten
// partitions." The fold is a native disclosure rather than a remembered flag — the
// control is keyboard-reachable and announced as expandable, and there is nothing to
// restore after a re-render.
//
// AND THE FOLD IS WHY THIS PAGE HOLDS ONE THING. A listing that refreshes while a
// clear is running can move that partition's row across the fold, which is a different
// parent element and therefore a remount: a round recorded in the row came back idle
// mid-act, with the button enabled again and both settlements writing into a component
// that no longer existed. `PartitionClearRounds` is minted here, above the fold, and
// threaded down. It is still no fetch, no store, and no effect.

import { useState } from "react";

import { BrowserPolicySettings, type BrowserPolicySettingsProps } from "./PolicySettings.js";
import { PartitionTable } from "./PartitionTable.js";
import { PartitionClearRounds } from "./partition-clear-rounds.js";
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
  // The one thing this page holds, and it holds it because nothing below it can: the
  // table folds, so a listing that refreshes mid-clear moves a row between two lists
  // and React remounts it. A round recorded in the row would be lost there.
  const [clearRounds] = useState(() => new PartitionClearRounds());

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
          rounds={clearRounds}
          onClearSiteData={props.onClearSiteData}
          onClosePane={props.onClosePane}
        />
      </section>
    </section>
  );
}
