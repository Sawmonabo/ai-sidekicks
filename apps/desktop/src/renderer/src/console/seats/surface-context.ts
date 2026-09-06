// What a surface is handed, below every module that hands it one.
//
// HOISTED OUT OF `surface-registry.ts` for `pane-context.ts`'s reason and no other: the
// frame's board mounts a reserved frame while a loader-backed surface is in flight, so
// the registry reaches `PendingSurfaceBody.tsx`, which names the context a surface is
// mounted with. Declaring that context in the registry made the pair a cycle, and the
// layering gate counts type edges so an `import type` cannot hide one.

import { type ConsoleBridge } from "../bridge/index.js";
import { type DraftStore, type UiStateStore } from "../persistence/index.js";
import type { ConsoleRoute } from "../routing/index.js";
import { type FrameStore, type SessionStore, type SessionStoreRegistry } from "../store/index.js";
import type { ConsolePaneRegistry } from "./pane-registry.js";

/** Everything a surface is handed. Nothing here is global; all of it is per window. */
export interface ConsoleSurfaceContext {
  readonly route: ConsoleRoute;
  readonly bridge: ConsoleBridge;
  readonly frameStore: FrameStore;
  /** The session store for the route's session, or `undefined` on a bare route. */
  readonly sessionStore: SessionStore | undefined;
  /**
   * Every session this window has open — the only session set the renderer can
   * name, since no bridge member lists a node's sessions. A surface that has to
   * OFFER sessions reads it; a surface that renders one reads `sessionStore`.
   */
  readonly sessionStoreRegistry: SessionStoreRegistry;
  /**
   * The pane board THIS composition registered its bodies into.
   *
   * On the context rather than reached for, and here rather than as one surface's
   * prop, because it is the same fact for every family: a surface that opens a pane
   * has to resolve it from the board the composition around it filled.
   * `registerConsoleFamilies` already takes the board as a parameter so a test and an
   * auxiliary window can compose their own — and a surface that then read the
   * process-wide singleton would hand that composition a production body, or the
   * reserved absence where production has none, however carefully it had asked.
   *
   * Required rather than defaulted to the singleton, on the composition site's own
   * rule: a default is the same hard-coding one parameter along, and a caller that
   * forgets it still reads production.
   */
  readonly paneRegistry: ConsolePaneRegistry;
  readonly uiStateStore: UiStateStore;
  readonly draftStore: DraftStore;
}
