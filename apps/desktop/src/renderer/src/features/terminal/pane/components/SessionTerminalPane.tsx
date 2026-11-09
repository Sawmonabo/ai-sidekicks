// The terminal pane once a session is addressed: the session's shells, read off its shell list.
//
// Split from `TerminalPane.tsx` because the store hooks may only be called when there is a store.
// Until the list is read the pane reads `Loading the terminal…`; with no tab strip yet it shows
// the list's first shell, and a session with none has one opened for it.

import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { type SessionStore } from "#renderer/store/session/store.js";
import { type WindowStore } from "#renderer/store/window/store.js";
import { useSessionShells } from "../hooks/useSessionShells.js";
import { ShellBody } from "./ShellBody.js";

/** The bridge the shells' streams ride, the session's store, and the window's, for this device. */
export interface SessionTerminalPaneProps {
  readonly bridge: PlatformBridge;
  readonly sessionStore: SessionStore;
  readonly frameStore: WindowStore;
}

/** The session's shown shell, or the line saying it is not read yet or why it cannot be. */
export function SessionTerminalPane(props: SessionTerminalPaneProps): React.JSX.Element {
  const { bridge, sessionStore, frameStore } = props;
  // The store keys a session by the daemon's own id.
  const sessionId = sessionStore.sessionId as SessionId;
  const { terminals, refusal } = useSessionShells(bridge, sessionId);
  const shownShell = terminals?.[0];

  return (
    <>
      {shownShell === undefined ? (
        <Nothing kind="not-loaded" placement="block" title="Loading the terminal…" />
      ) : (
        <ShellBody
          key={shownShell.terminalId}
          bridge={bridge}
          sessionId={sessionId}
          sessionStore={sessionStore}
          frameStore={frameStore}
          shell={shownShell}
        />
      )}
      {refusal === undefined ? null : <InlineRefusal code={refusal.code} detail={refusal.detail} />}
    </>
  );
}
