// The workflow run pane's body, as the deck's registry loads it.
//
// A LOADER-BACKED BODY, so a run pane's operator controls, park surfacing, and phase
// column stay off the initial import graph. The phase graph beneath it is already a
// nested lazy chunk of its own and stays one: this boundary is the outer of two, and
// opening a run pane fetches the pane without fetching the graph until a person asks
// for it.
//
// BESIDE THE PANE AND NOT IN THE FAMILY DOOR. `workflows/index.ts` composed both pane
// renderers into a table, which meant the door named `WorkflowRunPane` by static import
// and the whole surface travelled with the launch. The door now names this module in an
// `import()` and nothing else.

import { createElement } from "react";

import { WorkflowRunPane } from "./run/index.js";
import { paneBodyForKind, type ConsolePaneContext } from "../../seats/index.js";

/**
 * The run pane, at an address the deck resolved to this kind.
 *
 * `paneBodyForKind` narrows the address union to this kind's own arm and renders the
 * chrome's typed refusal for any other, which is the family door's own reasoning kept
 * intact across the move: a boundary refuses by name and leaves the surface standing.
 */
export const Body: (context: ConsolePaneContext) => React.ReactNode = paneBodyForKind(
  "workflow-run",
  (context) => createElement(WorkflowRunPane, { context }),
);
