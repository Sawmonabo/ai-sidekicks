// The sidekicks page's body, and the root of the chunk it arrives in.
//
// A LOADER-BACKED BODY, so the page, its registry view, its rows, and its editor seat are
// not on the initial import graph. The page is a SETTINGS section: a person navigates to
// settings and then chooses a section, which is two acts after the first paint.
//
// WHY THIS ROOT EXISTS AT ALL, RATHER THAN THE SETTINGS REGISTRATION NAMING THE FAMILY
// DOOR. The door is `../index.ts`, and `session-surfaces-family.ts` imports it EAGERLY for
// the agent console's surface registration — so the door is in the entry chunk by
// construction. A dynamic import of a module already assigned to the static chunk defers
// nothing: the bundler resolves it to the chunk that is already there, and the page would
// ride along exactly as it did while the registration held a `render`. The boundary has to
// name a module the eager graph does not reach, which is this one.
//
// THE PAGE'S SHEET ENTERS HERE, for the same reason and measured the same way. It sat at
// the family door, which put the rules for a settings section on every session's initial
// document — `agents/index.ts` records the state it was in. The move is admitted by the
// module-shape collision rule in `apps/desktop/AGENTS.md`: no other family declares a class
// this sheet declares, so deferring it changes no surface but this page's own. This is the
// only root that reaches the page, so the sheet is named once rather than from a pair of
// roots the way the agent console's seven are.
//
// WHAT IT DECLARES IT NEEDS IS A BRIDGE AND A RETAINED SESSION, and that is the whole of
// it. `LoadedLazyBody` asks for a body taking the board's context — here
// `SettingsPageContext` — and a function accepting a wider parameter satisfies one
// expecting a narrower, so naming the two members this page reads is both sufficient and
// true. Naming the settings context instead would make the agents family import the
// settings family's vocabulary, which `console-view-family-isolation` in
// `.dependency-cruiser.mjs` fails, and it would claim a dependency on a rail and on that
// session's store that this page does not have: it reads the node-local definition
// registry, deletes through the same port, and navigates nowhere.
//
// THE SESSION ID IS HERE BECAUSE ONE ACT ON THIS PAGE IS SESSION-SCOPED. The registry is
// node-local, but attaching from a row is not: an agent joins a session, and the only
// session this page can name is the one this window is working in. It is threaded rather
// than derived so the page never picks one, and `undefined` is a real answer — a window
// that has opened no session offers no attach control at all.

import "./sidekick-definitions-page.css";

import { createElement } from "react";

import type { ConsoleBridge } from "../../bridge/index.js";
import { SidekickDefinitionsPage } from "./SidekickDefinitionsPage.js";

/** The saved-sidekick registry page, as the settings board loads it. */
export function Body(context: {
  readonly bridge: ConsoleBridge;
  readonly retainedSessionId: string | undefined;
}): React.ReactNode {
  return createElement(SidekickDefinitionsPage, {
    bridge: context.bridge,
    retainedSessionId: context.retainedSessionId,
  });
}
