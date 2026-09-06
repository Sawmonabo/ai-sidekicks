// The runs pane's door: one kind claimed, one body behind it.
//
// THE FAMILY DOOR, and the family's one barrel. The body lives under `pane/` beside
// this file rather than inside `panes/`: that directory is a COMPOSITION SITE, which
// sits above every family by construction, so a body parked there is reachable from a
// sibling family only by an upward import the layering gate cannot see — both
// composition sites are subtracted from its endpoints so `panes/index.ts` may name
// every family. `panes/index.ts` calls the function below; nothing else here is
// reachable from outside this directory.
//
// A pane family registers through its own barrel and never edits the pane registry
// or the pane-kind set — `panes/index.ts` says why, and the short version is that a
// registry six branches edit at once is a merge that resolves cleanly while
// dropping someone's registration.
//
// The owner string is the KIND's owner rather than the family's. The registry
// refuses a second owner on one kind, and a refusal that named a whole family would
// leave a reader hunting three directories for which body is already there.

// THE STYLESHEET IS IMPORTED HERE, and here only. This is the subtree's door —
// every runs surface is reached through the body this file registers — so the
// bundler sees one edge into the sheet rather than one per component, and a runs
// surface can no more arrive without its CSS than a primitive can. `seats/index.ts`
// records the same reasoning for the frame every pane wears.

import { createElement } from "react";

import { paneBodyForKind, type ConsolePaneRegistry } from "../seats/index.js";
import { RunsPane } from "./pane/RunsPane.js";

import "./pane/runs.css";
// The intervention surfaces carry their own sheet beside the pane's, split at the
// same seam their components are; rules addressing selectors in both sheets stay
// in `runs.css` as a single declaration.
import "./pane/interventions/run-interventions.css";

/**
 * Claim the `runs` kind.
 *
 * The descriptor makes no claim about being torn off — `isDetachablePaneKind` is
 * the one answer, read off the window model rather than advertised here, and the
 * runs list is not among the kinds it admits.
 */
export function registerRunsPane(registry: ConsolePaneRegistry): void {
  registry.register({
    kind: "runs",
    owner: "runs-pane",
    // Narrowed to this kind's own address arm before the body sees it, so the body
    // reads the entity its kind admits and nothing else. `createElement` rather than
    // JSX: this is a `.ts` module, and the naming rule reserves `.tsx` for a single
    // PascalCase component per file.
    render: paneBodyForKind("runs", (context) => createElement(RunsPane, context)),
  });
}
