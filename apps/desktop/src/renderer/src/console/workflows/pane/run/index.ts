// The run pane's door: the body the deck mounts for the `workflow-run` kind.
//
// A SUB-MODULE DOOR, NOT A SECOND FAMILY DOOR. This directory publishes to the
// workflows family and to nothing above it — `workflows/index.ts` is its one reader,
// and it reaches this module by a deep intra-family specifier, which is what
// `apps/desktop/AGENTS.md` §Module shape means by a sub-module door. Everything else
// under here is reached from inside the directory.
//
// ONE EXPORT, for the phase-graph door's reason one level down: the pane body is the
// whole of what the deck mounts, and a second export here would be a second way into
// a directory whose one entry point is a registered descriptor's `render`.
//
// THE PANE'S STYLESHEET ENTERS HERE. `apps/desktop/AGENTS.md` admits a stylesheet
// through the barrel of the surface that owns it and through no component. This
// pane's controls are that surface. The sheet was `@import`ed from the family's own
// `workflows.css` while the body lived under `console/panes/`, which put it on the
// initial document for every session that never opened a run pane and made a sheet in
// one directory the reason a surface in another was styled at all.

import "./run-controls.css";

export { WorkflowRunPane } from "./WorkflowRunPane.js";
