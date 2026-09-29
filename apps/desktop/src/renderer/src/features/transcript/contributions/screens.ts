// The session's workspace screen: the session header, the pane layout, and the
// composer's seat, which the composition root hands in.

import { createElement, type ComponentType, type ReactNode } from "react";

import { routeSessionId } from "@renderer/routing/route-readers.js";
import { type ScreenContext, type ScreenRegistry } from "@renderer/console/seats/index.js";
import { ResumeRefusalBanner } from "../components/ResumeRefusalBanner.js";
import { TranscriptSurface } from "../TranscriptSurface.js";

/**
 * What the composition root supplies this feature, because this file may not import it.
 *
 * The session workspace's body belongs to another feature, and no feature imports
 * another, so the component arrives as a parameter named by the composition root, which
 * sits above every feature and is the one place allowed to name more than one.
 *
 * The COMPONENT rather than a built element: which component mounts is the root's
 * decision, and what it is handed is this file's — the surface context exists only when
 * the slot renders, which is long after the root registered it.
 */
export interface TranscriptComposition {
  readonly workspace: ComponentType<WorkspaceMountProps>;
}

/**
 * Claim the workspace screen.
 *
 * Takes the registry rather than reaching for the module-scope singleton, so a test
 * composes into a registry it owns. The transcript's commands are registered by their
 * own contribution, `registerTranscriptCommands`, which the composition root calls
 * beside this.
 */
export function registerTranscriptScreens(
  registry: ScreenRegistry,
  composition: TranscriptComposition,
): void {
  registry.register({
    slot: "workspace",
    owner: TRANSCRIPT_OWNER,
    render: (context) => mountWorkspace(context, composition.workspace),
  });
}

/**
 * The owner string every transcript claim carries.
 *
 * One binding rather than a literal per descriptor: the surface registry's
 * duplicate policy is owner-scoped, so re-registering under the same owner replaces
 * and a different owner is refused by name. Two spellings of this feature's own name
 * would make a hot reload a collision.
 */
export const TRANSCRIPT_OWNER = "ledger";

/**
 * What the workspace slot hands its body.
 *
 * Derived from the surface context rather than restated, so a member added there is
 * carried here without a second declaration to keep in step. `sessionStoreRegistry` is
 * subtracted because the workspace renders ONE session — a surface that has to offer
 * sessions reads the registry, and this one is handed the session it is a view of — and
 * `chooseScheme` because nothing in a session chooses the color scheme.
 */
type WorkspaceMountProps = Omit<ScreenContext, "sessionStoreRegistry" | "chooseScheme">;

/**
 * Mount the session workspace: the session header, the deck, and the composer's seat.
 *
 * The wrapper keeps the surface's full-height grid, which is what lets the deck
 * inside it be the thing that scrolls rather than the window.
 *
 * WHY THE KEY, AND WHY A KEY IS THE RIGHT INSTRUMENT. The workspace holds per-session
 * state that nothing else resets: the deck's arrangement, and the record of which
 * panes are showing in windows of their own. The shell deliberately OPENS session
 * stores and never closes them on navigation, so moving from one already-open session
 * to another re-renders this position rather than unmounting it — and every one of
 * those pieces would carry the first session's panes and windows into the second. A
 * key on the session is what makes the subtree's lifetime match the thing it holds
 * state about; the alternative is a reset effect per piece, which is the same rule
 * written once per field and forgotten on the next one.
 */
function mountWorkspace(
  context: ScreenContext,
  Workspace: ComponentType<WorkspaceMountProps>,
): ReactNode {
  const sessionId = routeSessionId(context.route);
  return createElement(
    TranscriptSurface,
    null,
    // ABOVE the workspace body and never in place of it. The refused arm says the
    // position this session was last read up to could not be resolved and the log was
    // re-read from the beginning of its window, which the surface below is unaffected
    // by: the store projects, the subscription tails, and what was lost is a remembered
    // place. The component is conditional rather than its hooks, which is the only
    // shape React allows for a reading whose session id may not exist.
    sessionId === undefined
      ? null
      : createElement(ResumeRefusalBanner, {
          registry: context.sessionStoreRegistry,
          sessionId,
        }),
    createElement(Workspace, {
      key: sessionId ?? "no-session",
      bridge: context.bridge,
      frameStore: context.frameStore,
      sessionStore: context.sessionStore,
      uiStateStore: context.uiStateStore,
      draftStore: context.draftStore,
      route: context.route,
      paneRegistry: context.paneRegistry,
    }),
  );
}
