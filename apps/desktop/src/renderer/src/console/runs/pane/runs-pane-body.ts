// The runs pane's body, as the registry loads it, and the root of its chunk.
//
// A LOADER-BACKED BODY. The runs list opens from the composer's own controls and from
// a run address; nothing paints it before a person asks for one. What rides behind the
// boundary with it is the whole of this subtree — the run-state feed, the projection,
// the seating model, the intervention surfaces, and both stylesheets — none of which a
// session that never opens the pane has any use for.
//
// THE SHEETS ENTER HERE RATHER THAN AT THE DOOR, which is `apps/desktop/AGENTS.md`'s
// stylesheet rule read the way it is written: the owner is the directory that carries
// the chunk, and putting these on the family door would leave the pane's rules on the
// initial document of every session while the body itself was deferred.
//
// Named `Body` because `seats/lazy-body.ts` fixes the export name a loader resolves.

import { createElement } from "react";

import { paneBodyForKind, type ConsolePaneContext } from "../../seats/index.js";
import { RunsPane } from "./RunsPane.js";

import "./runs.css";
// The intervention surfaces carry their own sheet beside the pane's, split at the
// same seam their components are; rules addressing selectors in both sheets stay
// in `runs.css` as a single declaration.
import "./interventions/run-interventions.css";

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
