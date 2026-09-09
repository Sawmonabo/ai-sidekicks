// The runs pane's body, as the registry loads it, and the root of its chunk.
//
// A LOADER-BACKED BODY. The runs list opens from the composer's own controls and from
// a run address; nothing paints it before a person asks for one. What rides behind the
// boundary with it is the whole of this subtree — the run-state feed, the projection,
// the seating model, and the intervention surfaces — none of which a session that never
// opens the pane has any use for.
//
// THE SHEETS ARE THE ONE THING THAT DOES NOT RIDE WITH IT, and `runs/index.ts` carries
// the measurement that said why: `runs.css` declared `.meridian-run-row__failure`, which
// `workflows/runs/run-list.css` also declares, so while both sheets were on the document
// the later one decided how the WORKFLOWS run list drew a failed run. That collision is
// settled — this pane's line is `.meridian-runs__failure` — so deferring the sheets can
// no longer reach another family's surface. They stay on the door until a change that
// measures the deferral moves them.
//
// Named `Body` because `seats/lazy-body/lazy-body.ts` fixes the export name a loader resolves.

import { createElement } from "react";

import { paneBodyForKind, type ConsolePaneContext } from "../../seats/index.js";
import { RunsPane } from "./RunsPane.js";

/**
 * The runs list, at an address the deck resolved.
 *
 * Narrowed to this kind's own address arm before the body sees it, so the body reads
 * the entity its kind admits and nothing else. `createElement` rather than JSX: this is
 * a `.ts` module, and the naming rule reserves `.tsx` for a single PascalCase component
 * per file.
 */
export const Body: (context: ConsolePaneContext) => React.ReactNode = paneBodyForKind(
  "runs",
  (context) => createElement(RunsPane, context),
);
