// The pane layout's chords through the window's real binding table, pressed with a real keyboard:
// in the terminal's body a move's chord is the shell's, reaching the emulator and moving no pane;
// on the terminal's frame the same chord moves it. The emulator is the real one, since the claim
// is that its input is a field the table leaves alone. `$mod+I` opens the inspector on the
// session's workspace beside the focused pane, which takes the focus back when it closes.

import { act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { userEvent } from "vitest/browser";

import { withDaemonCall } from "#test/helpers/fixture/bridge.js";

import { renderSettled } from "../../helpers/app/harness.js";
import { FixtureBridgeProvider } from "../../helpers/app/frame-fixtures.js";
import { layoutPaneContext } from "../../helpers/pane-context.js";

import { installMeridianTokens } from "#renderer/app/token-installation.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { PaneFrame } from "#renderer/components/PaneFrame/PaneFrame.js";
import { registerPaneLayoutCommands } from "#renderer/features/sessions/index.js";
import { SessionPaneLayout } from "#renderer/features/sessions/pane-layout/components/SessionPaneLayout.js";
import { failOnPaneSizesRefusal } from "#renderer/features/sessions/pane-layout/kept-sizes.test-support.js";
import { openStore } from "#renderer/store/persistence/ui-state-store.test-support.js";
import { PaneLayoutStore } from "#renderer/features/sessions/pane-layout/store.js";
import { XtermMountPoint } from "#renderer/features/terminal/emulator/components/XtermMountPoint.js";
import { reclaimComponentHolds } from "#renderer/features/terminal/emulator/components/XtermMountPoint.test-support.js";
import { publishCommandWindow } from "#renderer/registries/commands/command-window.js";
import { CommandContributionRegistry } from "#renderer/registries/commands/contributions.js";
import { CommandRegistry } from "#renderer/registries/commands/registry.js";
import { KeybindingTable } from "#renderer/registries/keybindings/table.js";
import { PaneRegistry } from "#renderer/registries/panes/registry.js";
import { createFixtureBridge } from "#renderer/services/platform/bridge.fixture.js";
import { FIRST_RUN_SCENARIO } from "#fixtures/scenarios/first-run.js";

const TERMINAL_ID = "terminal-pane-chords";

/** The session the layout is drawn for, and the workspace it is bound to. */
const SESSION_ID = "0193a6c0-0000-7000-8000-00000000c001";
const WORKSPACE_ID = "0193a6c0-0000-7000-8000-00000000c002";
const REPO_MOUNT_ID = "0193a6c0-0000-7000-8000-00000000c003";

/** The key `$mod` stands for on the machine running the test, as the chord library reads it. */
const PLATFORM_MODIFIER_KEY = /Mac|iPod|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control";

afterEach(() => {
  cleanup();
  reclaimComponentHolds([TERMINAL_ID]);
});

/** Preview's frame, and the terminal's frame around a real emulator that reports each keystroke. */
function registryWithShell(onKeystroke: (data: string) => void): PaneRegistry {
  const registry = new PaneRegistry();
  registry.register({
    kind: "browser",
    owner: "pane-chords-test",
    render: () => <PaneFrame kind="browser" sessionId={undefined} />,
  });
  registry.register({
    kind: "terminal",
    owner: "pane-chords-test",
    render: () => (
      <PaneFrame kind="terminal" sessionId={undefined}>
        <XtermMountPoint
          terminalId={TERMINAL_ID}
          isWriteEnabled
          label="Shell output"
          onKeystroke={onKeystroke}
        />
      </PaneFrame>
    ),
  });
  return registry;
}

/** Framed panes of `kinds` holding nothing, for a case about the frames alone. */
function framedRegistry(kinds: readonly ("browser" | "agents" | "inspector")[]): PaneRegistry {
  const registry = new PaneRegistry();
  for (const kind of kinds) {
    registry.register({
      kind,
      owner: "pane-chords-test",
      render: () => <PaneFrame kind={kind} sessionId={undefined} />,
    });
  }
  return registry;
}

/** The frame drawn for the open pane of `kind`. */
function frameOf(container: HTMLElement, kind: string): HTMLElement {
  return (
    container.querySelector<HTMLElement>(`.meridian-pane--${kind}`) ??
    expect.fail(`no ${kind} pane is drawn`)
  );
}

/** The pane commands and their chords in a table on this window, as the app composes them. */
function installPaneChords(): void {
  const registry = new CommandRegistry();
  const contributions = new CommandContributionRegistry(registry);
  registerPaneLayoutCommands(contributions);
  // Focus is in a pane throughout; the claim is the table's text-entry guard, not the clause.
  const table = new KeybindingTable({
    registry,
    readContext: () => ({ sessionActive: true, paneFocused: true }),
  });
  table.setBindings(contributions.keyBindings());
  onTestFinished(table.install(window));
  onTestFinished(publishCommandWindow(() => document));
}

describe("browser — the pane moves' chords", () => {
  it("leaves the chord to the shell, and moves the terminal from its frame", async () => {
    installMeridianTokens(document);
    installPaneChords();
    const keystrokes = vi.fn<(data: string) => void>();
    const layout = new PaneLayoutStore();
    layout.open({ kind: "browser" });
    layout.open({ kind: "terminal" });
    const fixture = createFixtureBridge({ scenario: FIRST_RUN_SCENARIO });
    const { container } = await renderSettled(
      <FixtureBridgeProvider fixture={fixture}>
        <LiveAnnouncerProvider>
          <SessionPaneLayout
            layout={layout}
            registry={registryWithShell(keystrokes)}
            paneContextFor={(pane) =>
              layoutPaneContext(pane, { bridge: fixture.bridge, sessionStore: undefined })
            }
            isSessionOpen
            sessionId={undefined}
            conversation={<p>the conversation</p>}
            uiStateStore={openStore()}
            onPaneSizesRefused={failOnPaneSizesRefusal}
          />
        </LiveAnnouncerProvider>
      </FixtureBridgeProvider>,
    );
    await waitFor(() => {
      const box = container.querySelector(".meridian-terminal-mount-point");
      expect(box?.getAttribute("data-renderer") ?? "pending").not.toBe("pending");
    });
    const shellInput = container.querySelector(".meridian-pane--terminal textarea");
    const terminalFrame = container.querySelector<HTMLElement>(".meridian-pane--terminal");
    if (!(shellInput instanceof HTMLTextAreaElement) || terminalFrame === null) {
      throw new Error("the terminal pane drew no emulator input");
    }

    act(() => {
      shellInput.focus();
    });
    await act(async () => {
      await userEvent.keyboard("{Alt>}{Shift>}{ArrowUp}{/Shift}{/Alt}");
    });
    expect(keystrokes).toHaveBeenCalled();
    expect(layout.snapshot().terminalPlace).toBe("below");

    // Negative control: the same chord on the terminal's frame, outside its body, moves it.
    keystrokes.mockClear();
    act(() => {
      terminalFrame.focus();
    });
    await act(async () => {
      await userEvent.keyboard("{Alt>}{Shift>}{ArrowUp}{/Shift}{/Alt}");
    });
    expect(layout.snapshot().terminalPlace).toBe("above");
    expect(keystrokes).not.toHaveBeenCalled();
  });

  it("opens the inspector beside the focused pane on $mod+I, and gives the focus back on close", async () => {
    installMeridianTokens(document);
    installPaneChords();
    const layout = new PaneLayoutStore();
    layout.open({ kind: "browser" });
    layout.open({ kind: "agents" });
    const fixture = createFixtureBridge({ scenario: FIRST_RUN_SCENARIO });
    const answered = withDaemonCall(fixture.bridge, async (call, passThrough) =>
      call.method === "repo.workspaceList"
        ? {
            workspaces: [
              {
                id: WORKSPACE_ID,
                repoMountId: REPO_MOUNT_ID,
                executionMode: "bound-root",
                state: "ready",
              },
            ],
          }
        : passThrough(),
    );
    const { container } = await renderSettled(
      <FixtureBridgeProvider fixture={{ ...fixture, bridge: answered.bridge }}>
        <LiveAnnouncerProvider>
          <SessionPaneLayout
            layout={layout}
            registry={framedRegistry(["browser", "agents", "inspector"])}
            paneContextFor={(pane) =>
              layoutPaneContext(pane, { bridge: answered.bridge, sessionStore: undefined })
            }
            isSessionOpen
            sessionId={SESSION_ID}
            conversation={<p>the conversation</p>}
            uiStateStore={openStore()}
            onPaneSizesRefused={failOnPaneSizesRefusal}
          />
        </LiveAnnouncerProvider>
      </FixtureBridgeProvider>,
    );

    act(() => {
      frameOf(container, "browser").focus();
    });
    await act(async () => {
      await userEvent.keyboard(`{${PLATFORM_MODIFIER_KEY}>}i{/${PLATFORM_MODIFIER_KEY}}`);
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(frameOf(container, "inspector"));
    });
    expect(layout.snapshot().panes.map((pane) => pane.kind)).toStrictEqual([
      "browser",
      "inspector",
      "agents",
    ]);
    expect(layout.snapshot().panes[1]?.entity).toStrictEqual({
      kind: "workspace",
      id: WORKSPACE_ID,
    });

    await act(async () => {
      await userEvent.keyboard("{Alt>}{Backspace}{/Alt}");
    });
    expect(layout.snapshot().panes.map((pane) => pane.kind)).toStrictEqual(["browser", "agents"]);
    expect(document.activeElement).toBe(frameOf(container, "browser"));
  });
});
