// The approvals pane's body, as the registry loads it, and the root of its chunk.
//
// A LOADER-BACKED BODY, on the runs pane's reasoning: the queue opens from a control
// and from an address, and the reader, the wire adapter, the card, the goal and grant
// sections, the posture surface, and both stylesheets ride behind the boundary with it.
//
// THE SHEETS ENTER HERE RATHER THAN AT THE DOOR. `apps/desktop/AGENTS.md` keys that
// rule on the directory that OWNS a sheet, and the owner is the directory carrying the
// chunk: importing them at the family door would put an approvals queue's rules on the
// initial document of every session that never opens one.
//
// Named `Body` because `seats/lazy-body.ts` fixes the export name a loader resolves.

import { createElement } from "react";

import { paneBodyForKind, type ConsolePaneContext } from "../../seats/index.js";
import { ApprovalsPane } from "./ApprovalsPane.js";

import "./approvals.css";
// The sections this pane hosts carry their own sheet beside the pane's, split at
// the same seam their components are: the rules that address selectors in BOTH
// sheets — the pane-wide control metrics and the one focus ring — stay in
// `approvals.css` as a single declaration rather than being written twice.
import "./approvals-sections.css";

/**
 * The approvals queue, at an address the deck resolved.
 *
 * Narrowed to this kind's own address arm before the body sees it, so the body reads
 * the entity its kind admits and nothing else. `createElement` rather than JSX: this is
 * a `.ts` module, and the naming rule reserves `.tsx` for a single PascalCase component
 * per file.
 */
export const Body: (context: ConsolePaneContext) => React.ReactNode = paneBodyForKind(
  "approvals",
  (context) => createElement(ApprovalsPane, context),
);
