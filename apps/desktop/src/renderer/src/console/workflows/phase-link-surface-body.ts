// The phase deep link's body, as the surface registry loads it, and the root of its
// chunk.
//
// A LOADER-BACKED SURFACE, for the workflows destination's reason one file over: this
// surface is reached by following a link, never painted before a person acts, which is
// the test `apps/desktop/AGENTS.md` states for the loader form. Registered with a
// `render` it would put the run pane's whole composition on the initial import graph of
// every session that never opens a workflow.
//
// IT CARRIES NO STYLESHEET, WHICH IS THE OWNERSHIP RULE AND NOT AN OMISSION. The three
// sibling roots name `workflows.css` because each paints this family's chrome; this one
// paints none of it. What stands inside it is the run pane, which arrives on its own
// chunk and names its own sheets there — so a sheet imported here would charge every
// follower of a phase link for rules nothing on this chunk can render against, and would
// put this family's chrome into the cascade at a moment decided by a bundle boundary.
//
// Named `Body` because `seats/lazy-body/lazy-body.ts` fixes the export name a loader resolves.

import { createElement } from "react";

import type { ConsoleSurfaceContext } from "../seats/index.js";
import { WorkflowPhaseLinkSurface } from "./WorkflowPhaseLinkSurface.js";

/**
 * The run pane a phase address opens, at the route the frame committed.
 *
 * The whole context, because a pane context is composed from it — the same input the
 * workflows destination's own root hands its host, and for the same reason.
 */
export const Body: (context: ConsoleSurfaceContext) => React.ReactNode = (context) =>
  createElement(WorkflowPhaseLinkSurface, { context });
