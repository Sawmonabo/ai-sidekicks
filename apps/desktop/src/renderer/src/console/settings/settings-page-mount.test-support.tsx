// How every settings-page suite builds the context its page reads, and mounts a page
// it can move between sessions.
//
// ONE CONTEXT BUILDER FOR THE FAMILY. `SettingsPageContext` is the shape every page
// in this family is handed, so a member added to it has to reach every harness that
// builds one. Three page harnesses had written their own — two byte-identical, and
// the third through `as unknown as SettingsPageContext`, which is the one of the three
// a widened context would NOT have failed. That is the drift this module exists to
// end: the builder is here, the cast is gone, and a new member is one compile error
// in one file.
//
// AND ONE MOVABLE MOUNT. Two harnesses also carried the same thirty-line recorder
// mount, differing only in which page element they composed — so it takes the page as
// a function of the context, which is the only thing that ever differed.

import { render } from "@testing-library/react";
import type { ReactNode } from "react";

import type { ConsoleBridge } from "../bridge/index.js";
import { LiveAnnouncerProvider } from "../primitives/index.js";
import { UNREPORTED_SHELL_STATE, type SessionStore, type ShellState } from "../store/index.js";
import { CommittedFrameRecorder } from "../core/committed-frame.test-support.js";
import type { SettingsPageContext } from "./settings-page-registry.js";

/**
 * The context a settings page is handed, over a bridge and a retained session.
 *
 * `retainedSessionId` is a required parameter and not a defaulted one: `undefined` is
 * the window that has opened no session, which several cases exist to drive, and a
 * default would silently answer those with a session id instead.
 *
 * `shellState` IS defaulted, and to the seeded unreported value rather than to a
 * healthy one: a page mounted by a case that says nothing about the shell is a page in
 * a window nobody has told anything, which is the state every shipped build is in
 * until the wire lands. A case that renders a degraded arm names its own.
 */
export function settingsPageContextWith(
  bridge: ConsoleBridge,
  retainedSessionId: string | undefined,
  retainedSessionStore?: SessionStore | undefined,
  shellState: ShellState = UNREPORTED_SHELL_STATE,
): SettingsPageContext {
  return {
    bridge,
    openSection: () => undefined,
    retainedSessionId,
    retainedSessionStore,
    shellState,
  } satisfies SettingsPageContext;
}

/** What one mounted page exposes to a case that moves it between sessions. */
export interface MountedMovablePage {
  readonly container: HTMLElement;
  /** Every frame committed since the last {@link MountedMovablePage.forgetFrames}. */
  readonly frames: readonly string[];
  readonly forgetFrames: () => void;
  readonly showSession: (retainedSessionId: string | undefined) => void;
}

/**
 * Mount a page beside a recorder, so a case can read the frames it committed.
 *
 * The subject move this supports is one commit long — see
 * `core/committed-frame.test-support.tsx` — so the case cannot look at the DOM
 * afterwards and see it.
 *
 * The page arrives as a function OF the context rather than as an element, because
 * the whole point is re-composing it under a different session on every re-render:
 * an element handed in would carry the session it was built with forever.
 */
export function renderMovablePage(
  pageFor: (context: SettingsPageContext) => ReactNode,
  bridge: ConsoleBridge,
  retainedSessionId: string | undefined,
): MountedMovablePage {
  const frames: string[] = [];
  const tree = (sessionId: string | undefined): ReactNode => (
    <LiveAnnouncerProvider>
      <CommittedFrameRecorder
        id="settings-page"
        onFrame={(committedText) => {
          frames.push(committedText);
        }}
      >
        {pageFor(settingsPageContextWith(bridge, sessionId))}
      </CommittedFrameRecorder>
    </LiveAnnouncerProvider>
  );
  const { container, rerender } = render(tree(retainedSessionId));
  return {
    container,
    frames,
    forgetFrames: () => {
      frames.length = 0;
    },
    showSession: (nextSessionId) => {
      rerender(tree(nextSessionId));
    },
  };
}
