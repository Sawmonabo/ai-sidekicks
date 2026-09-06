// The workflows destination's body, as the surface registry loads it, and the root of
// its chunk.
//
// A LOADER-BACKED SURFACE. `#/workflows` is a rail destination: nothing paints it until
// a person presses the rail or types the address, which is exactly the test
// `apps/desktop/AGENTS.md` states for the loader form. Registered with a `render` the
// host, the scope picker, the definitions browser, the run list, and everything they
// compose sat on the initial import graph of every session — and `preload("workflows")`
// on the palette and the pre-route-commit trigger had nothing to fetch, so the whole
// warming path was a no-op for the one destination it would have helped most.
//
// THE FAMILY'S PANE KINDS DO NOT TRAVEL WITH IT. `workflow-run` is registered with a
// `render` for a measured cascade reason `index.ts` states, and this module does not
// change that: the surface's chunk and the pane's registration are separate claims, and
// `WorkflowRunPane` stays statically referenced from the pane table. The parked-run
// pane's committed reference is 1440x1751 before and after this split (measured
// 2026-09-06 against `test/console/screenshot/workflows.test.tsx`).
//
// THE FAMILY'S SHEET DOES NOT TRAVEL WITH IT EITHER, for the same reason: `workflows.css`
// stays at the door while `workflow-run` is static, because a static pane may not render
// against rules that arrive with a chunk it does not pull.
//
// ONE SHEET TRAVELS WITH IT. `definitions/definitions-browser.css` dresses
// `DefinitionsBrowser.tsx`, whose only reader is this chunk — it was `@import`ed from
// `workflows.css` at the door, so every session paid for rules nothing on the initial
// graph could render against. The family's other sheets stay at the door: `workflows.css`
// itself and `parks/park-badge.css` dress the statically registered run pane, and
// `runs/run-list.css` declares a class the RUNS family also declares, so where it lands
// in the cascade is not this family's decision alone.
//
// Named `Body` because `seats/lazy-body.ts` fixes the export name a loader resolves.

import "./definitions/definitions-browser.css";

import { createElement } from "react";

import type { ConsoleSurfaceContext } from "../seats/index.js";
import { WorkflowsPaneHost } from "./WorkflowsPaneHost.js";

/**
 * The workflows destination, at the route the frame committed.
 *
 * THE HOST rather than the destination or the browser, and each step of that is the
 * seat's own reasoning. `#/workflows` is a BARE route, so `context.sessionStore` is
 * `undefined` on it by construction while the definition enumeration's request carries a
 * required session id — handed the browser, this seat could only mount a surface whose
 * read was permanently unasked, so the destination resolves the session first. And the
 * destination opens panes rather than owning them: the two pane kinds this family claims
 * are what its lists lead to, and the slot needs a place to put one, which
 * `WorkflowsPaneHost.tsx` is.
 *
 * The whole context, because a pane body is composed from it: a bridge, both stores, the
 * window store, and the pane's own address. Handing the host three inputs would mean
 * handing it six the day it composes that context, which is today.
 */
export const Body: (context: ConsoleSurfaceContext) => React.ReactNode = (context) =>
  createElement(WorkflowsPaneHost, { context });
