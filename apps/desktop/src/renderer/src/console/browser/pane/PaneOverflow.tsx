// Everything the pane offers that is one click away rather than on the row.
//
// `Spec-023 §Console Design (Meridian)` 12.1 Density: "Chrome is one row: tabs,
// address, six controls. The page picker, capture target, developer tools, and
// site-data reset live in one overflow control." 12.2 Density says the same from the
// other side and adds pick element to the list.
//
// SO THE VISIBLE ROW IS SIX CONTROLS AND THE FIELD, counted rather than asserted:
// back, forward, the reload/stop slot, new page, open externally, and this control.
// Everything else in the chapter is inside it, which is what keeps the pane's chrome
// one row at the pane's minimum width.
//
// ONE DISCLOSURE AND NOT SIX. Each region below could have been its own fold, and
// then the density rule would be six clicks rather than one — the control is the
// design's answer to "where does the rest go", and splitting it re-asks the question.
// The regions inside it are headed rather than separated, so a person scanning for
// the file control does not have to open anything to find it.
//
// THE PANE COMPOSES, THIS COMPOSES THE REST. Every reading here is read where the
// pane holds it and passed in; nothing in this module calls the bridge. That is what
// lets the whole overflow be driven from a test with four literals, and it is why
// `chrome-acts.ts` exists — the acts are one object rather than nine callbacks.

import type { ConsoleRefusal } from "../../core/index.js";
import type { SessionStore } from "../../store/index.js";
import { Nothing } from "../../primitives/index.js";
import type { ProducedObjectCard } from "../cards/produced-objects.js";
import { SessionProducedObjects } from "../cards/SessionProducedObjects.js";
import { ToolCallFeed } from "../cards/ToolCallFeed.js";
import type { ToolCallReading } from "../cards/tool-call-relay.js";
import { ChromeControl } from "./ChromeControl.js";
import type { BrowserChromeActs } from "./chrome-acts.js";
import type { AdmittedRootsReading } from "./file-boundary.js";
import { FileControl } from "./FileControl.js";
import type { HandbackBinding } from "./handback-binding.js";
import { HandbackReading } from "./HandbackReading.js";
import { PagePicker } from "./PagePicker.js";
import type { PageListReading } from "./page-state.js";

export interface PaneOverflowProps {
  readonly acts: BrowserChromeActs;
  readonly pages: PageListReading;
  /** False where the host could not be created, which makes developer tools absent. */
  readonly canOpenDevtools: boolean;
  readonly roots: AdmittedRootsReading;
  /** The pane's current act refusal, read only to recognise the boundary's own. */
  readonly refusal: ConsoleRefusal | undefined;
  /** The session whose log the shelf folds, or `undefined` on a pane without one. */
  readonly sessionStore: SessionStore | undefined;
  readonly producedCards: ReadonlyMap<string, ProducedObjectCard>;
  readonly toolCalls: ToolCallReading;
  /** What 12.4's two unprompted halves are doing. Standing state, never the banner. */
  readonly handback: HandbackBinding;
  /** Capture the visible page. Held by the pane, because the answer becomes a card. */
  readonly onCapture: () => void;
}

export function PaneOverflow(props: PaneOverflowProps): React.JSX.Element {
  const { acts, pages, canOpenDevtools, roots, refusal, toolCalls, onCapture } = props;

  return (
    <details className="meridian-browser-disclosure meridian-browser-pane__overflow">
      <summary>More</summary>
      <div className="meridian-browser-pane__overflow-body">
        <section className="meridian-browser-region">
          <h3 className="meridian-browser-region__head">Pages</h3>
          <PagePicker reading={pages} acts={acts} canOpenDevtools={canOpenDevtools} />
        </section>

        <section className="meridian-browser-region">
          <h3 className="meridian-browser-region__head">This page</h3>
          <div className="meridian-browser-region__controls">
            <ChromeControl label="Capture" onActivate={onCapture} />
            <ChromeControl label="Pick element" onActivate={acts.pickElement} />
            {/* Hiding is the counterpart of the picker's Show: 12.7 keeps visibility
              an explicit act in both directions so an agent's background page and a
              pane showing nothing are reachable states rather than accidents. */}
            <ChromeControl label="Hide page" onActivate={acts.hidePage} />
          </div>
        </section>

        <section className="meridian-browser-region">
          <h3 className="meridian-browser-region__head">Local files</h3>
          <FileControl acts={acts} roots={roots} refusal={refusal} />
        </section>

        <section className="meridian-browser-region">
          <h3 className="meridian-browser-region__head">Produced objects</h3>
          {props.sessionStore === undefined ? (
            // NOT `empty`, which would claim a session was looked at and held no
            // artifacts. There is no session to look at, so nothing was checked and
            // the kind that says so is the honest one.
            <Nothing
              kind="not-checked"
              placement="inline"
              title="No session behind this pane"
              detail="Produced objects are a session's artifacts, and this pane is not in one."
            />
          ) : (
            <SessionProducedObjects
              sessionStore={props.sessionStore}
              cardsByArtifactId={props.producedCards}
            />
          )}
        </section>

        <section className="meridian-browser-region">
          <h3 className="meridian-browser-region__head">Agent tool calls</h3>
          <ToolCallFeed reading={toolCalls} />
        </section>

        <section className="meridian-browser-region">
          <h3 className="meridian-browser-region__head">Keyboard handback</h3>
          <HandbackReading handback={props.handback} />
        </section>

        <section className="meridian-browser-region">
          <h3 className="meridian-browser-region__head">Site data</h3>
          {/* Named before it is armed, which 12.5 requires: "The site-data control
            names what it clears, in this session's scope, before it is armed." The
            ordering it describes — every page closed first, then the partition store
            and the profile directory — is the daemon's, and the sentence states it so
            a person knows what pressing this does to pages they have open. */}
          <p className="meridian-browser-region__note">
            Clears this session&rsquo;s cookies, site storage, and profile directory. Every page in
            the session is closed first, because a live page writes its cookies back when it closes.
          </p>
          <ChromeControl label="Clear site data" onActivate={acts.clearSiteData} />
        </section>
      </div>
    </details>
  );
}
