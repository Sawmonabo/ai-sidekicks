// The artifact pane's body, as the deck's registry loads it.
//
// A loader-backed body for `repos/diff-pane/diff-pane-body.ts`'s reason, and beside the
// component rather than in `family-bodies.ts` for the same one. The three inline cards
// this family also registers — diff, artifact, attachment — stay static there: they are
// ledger rows in a session's own timeline, not panes somebody opens.

import { createElement } from "react";

import { ArtifactPane } from "./ArtifactPane.js";
import { paneBodyForKind, type ConsolePaneContext } from "../../seats/index.js";

/** The artifact pane, on the narrowing the diff body's module explains. */
export const Body: (context: ConsolePaneContext) => React.ReactNode = paneBodyForKind(
  "artifact",
  (context) => createElement(ArtifactPane, { context }),
);
