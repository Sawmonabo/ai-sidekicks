// The composer picker's body, as the composer's seat loads it, and the root of its chunk.
//
// A LOADER-BACKED SEAT BODY, which is the same test the family's three loader-backed
// registrations pass and a different board. `apps/desktop/AGENTS.md` decides the
// registration form by asking whether a body is painted before a person acts, and the
// `+` menu is closed until somebody presses its disclosure — so the picker, the
// definition directory it reads through, the start act it dispatches, and the denial it
// renders are all code that a session which never opens that menu should not carry.
//
// IT WAS A DOOR RE-EXPORT, and what that cost is the reason this file exists. The rail
// imported `WorkflowStartMenu` from the family door and the door re-exported it from
// beside this file — two static paths into one directory, and `families.ts` imports that
// door eagerly to register this family's surfaces, so the body sat in the entry chunk of
// every session whether or not the menu was ever opened. A `body: () => import(…)` shape
// written while either of those edges survived would have deferred nothing: a module
// reachable both statically and dynamically is assigned to the STATIC chunk, which is the
// hazard this file exists to remove, and the one a reviewer checks a `body:`
// registration against.
//
// THE FAMILY'S MENU SHEET TRAVELS WITH IT, on the rule the three sibling roots follow:
// the stylesheets a lazily loaded directory owns enter through that chunk's root and not
// through the family door. `workflow-start-menu.css` dresses this body and nothing else,
// and it declares no class name another family declares — checked against the tree
// rather than assumed — so
// where it lands in the cascade is this directory's own decision to make.
//
// WHAT DOES NOT TRAVEL IS `workflows.css`. The three sibling roots each name the family's
// chrome because each paints a surface standing inside it; this body paints inside the
// composer's `+` panel, which is the composer's chrome and already on the initial
// document. A sheet imported here would charge every opener of this menu for rules
// nothing on this chunk renders against.
//
// Named `Body` because `seats/lazy-body/lazy-body.ts` fixes the export name a loader resolves.

import "./workflow-start-menu.css";

import { createElement } from "react";

import { WorkflowStartMenu, type WorkflowStartMenuProps } from "./WorkflowStartMenu.js";

/**
 * The definition picker and the start it dispatches, in the seat the composer reserves.
 *
 * The whole context, because the context IS this body's props: the seat hands down the
 * port both wires ride, the session a run would start in, and the channel the composer is
 * addressed within where it is addressed at one, and there is nothing here to narrow.
 */
export const Body: (context: WorkflowStartMenuProps) => React.ReactNode = (context) =>
  createElement(WorkflowStartMenu, context);
