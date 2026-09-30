// The session screen's registration: the session header, the pane layout and the
// composer, in the session screen component the composition root hands in.

import { createElement, type ComponentType, type ReactNode } from "react";

import { routeSessionId } from "@renderer/routing/route-readers.js";
import { type Refusal } from "@renderer/lib/refusal.js";
import { type ScreenContext } from "@renderer/registries/screens/screen-context.js";
import { type ScreenRegistry } from "@renderer/registries/screens/screen-registry.js";
import { ResumeRefusalBanner } from "../components/ResumeRefusalBanner.js";
import { SessionScreenContainer } from "../SessionScreenContainer.js";

/**
 * What the composition root supplies this feature. The session screen's body belongs to another
 * feature and no feature imports another, so it arrives as a component the root names; a
 * component rather than an element because the screen context exists only when the screen renders.
 */
export interface TranscriptComposition {
  readonly sessionScreen: ComponentType<SessionScreenMountProps>;
}

/**
 * Claim the session screen. Takes the registry so a test composes into one it owns; the
 * transcript's commands are registered separately by `registerTranscriptCommands`.
 */
export function registerTranscriptScreens(
  registry: ScreenRegistry,
  composition: TranscriptComposition,
): void {
  registry.register({
    name: "session",
    owner: TRANSCRIPT_OWNER,
    render: (context) => mountSessionScreen(context, composition.sessionScreen),
  });
}

/**
 * The owner string every transcript claim carries. The screen registry's duplicate policy is
 * owner-scoped, so one spelling replaces on re-registration and a hot reload never collides.
 */
export const TRANSCRIPT_OWNER = "transcript";

/**
 * What the session screen hands its body: the screen context minus `sessionStoreRegistry` (this
 * screen renders one session) and `chooseScheme`. The one thing it asks of the registry,
 * re-reading a session when a person presses `Try again`, is handed over as that act alone.
 */
type SessionScreenMountProps = Omit<ScreenContext, "sessionStoreRegistry" | "chooseScheme"> & {
  /** Reads one session again through the registry, for a person's press. */
  readonly rereadSession: (sessionId: string) => Refusal | undefined;
};

/**
 * Mount the session screen: the session header, the pane layout, and the composer. The body is
 * keyed on the session because the screen holds per-session state nothing else resets (the pane
 * layout's arrangement, the panes in windows of their own), and moving between two open sessions
 * re-renders this position rather than unmounting it.
 */
function mountSessionScreen(
  context: ScreenContext,
  SessionScreenBody: ComponentType<SessionScreenMountProps>,
): ReactNode {
  const sessionId = routeSessionId(context.route);
  return createElement(
    SessionScreenContainer,
    null,
    // Above the session screen body, never in place of it: a refused resume position does not
    // affect the body. The component is conditional rather than its hooks, because the session
    // id may not exist.
    sessionId === undefined
      ? null
      : createElement(ResumeRefusalBanner, {
          registry: context.sessionStoreRegistry,
          sessionId,
        }),
    createElement(SessionScreenBody, {
      key: sessionId ?? "no-session",
      bridge: context.bridge,
      frameStore: context.frameStore,
      sessionStore: context.sessionStore,
      uiStateStore: context.uiStateStore,
      draftStore: context.draftStore,
      route: context.route,
      paneRegistry: context.paneRegistry,
      rereadSession: (sessionIdToReread: string) =>
        context.sessionStoreRegistry.requestRefresh(sessionIdToReread, "user-request"),
    }),
  );
}
