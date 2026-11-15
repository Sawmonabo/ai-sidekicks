// The terminal pane once a session is addressed: the session's shells as a tab strip, read off its
// shell list, the line under the strip with the session's project and tree, the close question and
// the refusal line, and the active tab's shell. Each tab shown since the pane opened keeps its body
// mounted while another tab is shown, so a switch back shows its shell as it stood, with no
// emulator built and no scrollback read again; a body goes with its tab, or with the pane.
//
// Split from `TerminalPane.tsx` because the store hooks may only be called when there is a store.
// Until the list is read, and while the first shell is being opened for a session with none, the
// pane reads `Loading…` under its header after the short delay, since no tab strip is drawn before
// the list says which shells there are; once the last tab is closed it reads `No active terminal.`
// above the `+`, which takes the focus when this pane closed that tab.

import { useMemo } from "react";

import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { TerminalId, TerminalListEntry } from "@ai-sidekicks/contracts/terminal";

import { LoadingNotice } from "#renderer/components/LoadingNotice/LoadingNotice.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { refusalCause } from "#renderer/lib/code-words.js";
import { type TabMenuRow } from "#renderer/components/TabStrip/TabMenu.js";
import { TabStrip, type StripTab } from "#renderer/components/TabStrip/TabStrip.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";
import { type SessionStore } from "#renderer/store/session/store.js";
import { useMainProcessState } from "#renderer/store/window/hooks/useMainProcessState.js";
import { type WindowStore } from "#renderer/store/window/store.js";
import { useProjectTreeLine } from "../hooks/useProjectTreeLine.js";
import { useSessionShells } from "../hooks/useSessionShells.js";
import { CloseShellQuestion } from "./CloseShellQuestion.js";
import { OpenShellButton } from "./OpenShellButton.js";
import { ShellBody } from "./ShellBody.js";

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
  const thisDeviceId = useMainProcessState(frameStore).negotiation?.deviceId;
  const shells = useSessionShells(bridge, sessionId, thisDeviceId);
  const projectTreeLine = useProjectTreeLine(bridge, sessionId);
  const clock = useClock();
  const { terminals, activeTerminalId, shownTerminalIds, refusal, openShell, closeShells } = shells;
  const tabs = useMemo(() => terminals?.map(stripTabOf) ?? [], [terminals]);
  // In the order first shown, so a reordered strip moves no body.
  const keptShells = useMemo(
    () =>
      shownTerminalIds.flatMap(
        (terminalId) => terminals?.find((shell) => shell.terminalId === terminalId) ?? [],
      ),
    [shownTerminalIds, terminals],
  );
  const closeQuestion =
    shells.heldShellsAsked.length === 0 ? null : (
      <CloseShellQuestion
        heldShells={shells.heldShellsAsked}
        onAnswer={shells.answerCloseQuestion}
      />
    );
  // The code's words, since the service's sentence can name a shell or the session by its id.
  const refusalLine =
    refusal === undefined ? null : (
      <InlineRefusal
        code={refusal.code}
        detail={refusalCause(refusal.code, undefined, refusal.detail)}
      />
    );

  if (terminals === undefined || (terminals.length === 0 && shells.isOpening)) {
    return (
      <>
        <LoadingNotice clock={clock} placement="block" title="Loading…" />
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
          action={<OpenShellButton onOpen={openShell} isFocusedOnMount={shells.hasClosedHere} />}
        />
        {refusalLine}
      </>
    );
  }
  return (
    <>
      <TabStrip
        tabs={tabs}
        activeKey={activeTerminalId}
        clock={clock}
        onSelect={shells.selectShell}
        onClose={(terminalId) => {
          closeShells([terminalId]);
        }}
        onReorder={shells.reorderShell}
        menuRowsOf={(terminalId) => closeRowsOf(terminals, terminalId, closeShells)}
        trailing={<OpenShellButton onOpen={openShell} isFocusedOnMount={false} />}
      />
      {projectTreeLine === undefined ? null : (
        <p className="meridian-terminal-pane__tree-line">{projectTreeLine}</p>
      )}
      {closeQuestion}
      {refusalLine}
      {keptShells.map((shell) => (
        <ShellBody
          key={shell.terminalId}
          bridge={bridge}
          sessionId={sessionId}
          sessionStore={sessionStore}
          frameStore={frameStore}
          shell={shell}
          isShown={shell.terminalId === activeTerminalId}
          isFocusedOnOpen={shell.terminalId === shells.openedTerminalId}
          onTryAgain={openShell}
        />
      ))}
    </>
  );
}

// A shell that exited or never started keeps its tab, drawn ended, until its `×` clears it.
function stripTabOf(shell: TerminalListEntry): StripTab<TerminalId> {
  return { key: shell.terminalId, label: shell.title, isEnded: shell.status.state !== "running" };
}

// A tab's own rows: close it, the others, or those to its right. There is no close-everything row,
// since one press would end every shell in the session, a running server among them.
function closeRowsOf(
  terminals: readonly TerminalListEntry[],
  terminalId: TerminalId,
  closeShells: (terminalIds: readonly TerminalId[]) => void,
): readonly TabMenuRow[] {
  const ids = terminals.map((shell) => shell.terminalId);
  const others = ids.filter((listed) => listed !== terminalId);
  const toTheRight = ids.slice(ids.indexOf(terminalId) + 1);
  return [
    {
      label: "Close",
      onPress: () => {
        closeShells([terminalId]);
      },
    },
    {
      label: "Close others",
      onPress: () => {
        closeShells(others);
      },
      disabledReason: others.length === 0 ? "This is the only terminal." : undefined,
    },
    {
      label: "Close to the right",
      onPress: () => {
        closeShells(toTheRight);
      },
      disabledReason:
        toTheRight.length === 0 ? "No terminals to the right of this one." : undefined,
    },
  ];
}
