// The terminal pane once a session is addressed: the session's shells as a tab strip, read off its
// shell list, the refusal line under the strip, and the active tab's shell.
//
// Split from `TerminalPane.tsx` because the store hooks may only be called when there is a store.
// Until the list is read, and while the first shell is being opened for a session with none, the
// pane reads `Loading the terminal…`; once the last tab is closed it reads `No active terminal.`
// above the `+`.

import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { type SessionStore } from "#renderer/store/session/store.js";
import { type WindowStore } from "#renderer/store/window/store.js";
import { useSessionShells } from "../hooks/useSessionShells.js";
import { OpenShellButton } from "./OpenShellButton.js";
import { ShellBody } from "./ShellBody.js";
import { ShellTabStrip } from "./ShellTabStrip.js";

/** The bridge the shells' streams ride, the session's store, and the window's, for this device. */
export interface SessionTerminalPaneProps {
  readonly bridge: PlatformBridge;
  readonly sessionStore: SessionStore;
  readonly frameStore: WindowStore;
}

/** The session's shell tabs and the active one's body, or the line saying why there is none. */
export function SessionTerminalPane(props: SessionTerminalPaneProps): React.JSX.Element {
  const { bridge, sessionStore, frameStore } = props;
  // The store keys a session by the daemon's own id.
  const sessionId = sessionStore.sessionId as SessionId;
  const shells = useSessionShells(bridge, sessionId);
  const { terminals, activeTerminalId, refusal, openShell } = shells;
  const shownShell = terminals?.find((shell) => shell.terminalId === activeTerminalId);
  const refusalLine =
    refusal === undefined ? null : <InlineRefusal code={refusal.code} detail={refusal.detail} />;

  if (terminals === undefined || (terminals.length === 0 && shells.isOpening)) {
    return (
      <>
        <Nothing kind="not-loaded" placement="block" title="Loading the terminal…" />
        {refusalLine}
      </>
    );
  }
  if (terminals.length === 0) {
    return (
      <>
        <Nothing
          kind="empty"
          placement="block"
          title="No active terminal."
          action={<OpenShellButton onOpen={openShell} />}
        />
        {refusalLine}
      </>
    );
  }
  return (
    <>
      <ShellTabStrip
        terminals={terminals}
        activeTerminalId={activeTerminalId}
        onSelect={shells.selectShell}
        onClose={shells.closeShell}
        onOpen={openShell}
      />
      {refusalLine}
      {shownShell === undefined ? null : (
        <ShellBody
          key={shownShell.terminalId}
          bridge={bridge}
          sessionId={sessionId}
          sessionStore={sessionStore}
          frameStore={frameStore}
          shell={shownShell}
          onTryAgain={openShell}
        />
      )}
    </>
  );
}
