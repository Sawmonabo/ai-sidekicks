// The session screen's main column beside a row of panes that scrolls sideways, in Chromium on
// real input. A sideways wheel over a pane's body, as Shift turns a mouse wheel before the page
// sees it, moves the row and leaves the body where it was. With the row scrolled, the session
// header and the composer stand in the main column, as wide as the conversation and clear of the
// block. A pane move's chord pressed in the composer's draft moves no pane, where the same chord
// on a pane's frame does: the negative control.

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { userEvent } from "vitest/browser";

import { installMeridianTokens } from "#renderer/app/token-installation.js";
import { PaneFrame } from "#renderer/components/PaneFrame/PaneFrame.js";
import { registerComposerView } from "#renderer/features/composer/index.js";
import { registerPaneLayoutCommands } from "#renderer/features/sessions/index.js";
import {
  SESSION_ID,
  memoryStore,
  saveLayout,
  sessionStore,
  workspaceFor,
} from "#renderer/features/sessions/SessionScreen.test-support.js";
import { publishCommandWindow } from "#renderer/registries/commands/command-window.js";
import { CommandContributionRegistry } from "#renderer/registries/commands/contributions.js";
import { CommandRegistry } from "#renderer/registries/commands/registry.js";
import { KeybindingTable } from "#renderer/registries/keybindings/table.js";
import { PaneRegistry } from "#renderer/registries/panes/registry.js";
import { CONVERSATION_FLOOR_REM } from "#renderer/styles/palette.js";
import { DEFAULT_APPEARANCE_RECORD } from "#shared/appearance.js";

/** A screen narrower than the conversation's floor and both panes' floors beside it. */
const SCREEN_WIDTH_PX = 1100;
const SCREEN_HEIGHT_PX = 760;
/** A pane body taller than its pane, so it has a vertical scroll of its own to keep. */
const BODY_HEIGHT_PX = 3000;
/** How far one sideways wheel turn asks the row to move, in CSS pixels. */
const WHEEL_TRAVEL_PX = 200;

beforeAll(() => {
  registerComposerView();
});

afterEach(() => {
  cleanup();
});

describe("browser — the main column beside a row that scrolls", () => {
  it("moves the row on a sideways wheel over a body, the header and composer staying put", async () => {
    const screen = await mountScreen();
    const block = screen.element(".meridian-pane-layout__block");
    // The first pane's body, in view before the row moves, so reaching it scrolls nothing.
    const body = screen.element(".meridian-pane--agents .meridian-pane__body");
    expect(block.scrollWidth).toBeGreaterThan(block.clientWidth);
    expect(block.scrollLeft).toBe(0);

    await act(async () => {
      await userEvent.keyboard("{Shift>}");
      await userEvent.wheel(body, { delta: { x: WHEEL_TRAVEL_PX } });
      await userEvent.keyboard("{/Shift}");
    });
    await waitFor(() => {
      expect(block.scrollLeft).toBeGreaterThan(0);
    });
    expect(body.scrollTop).toBe(0);
    expect(body.scrollLeft).toBe(0);

    const conversation = screen
      .element(".meridian-pane-layout__conversation")
      .getBoundingClientRect();
    const blockBox = block.getBoundingClientRect();
    expect(conversation.width).toBeGreaterThanOrEqual(
      CONVERSATION_FLOOR_REM * DEFAULT_APPEARANCE_RECORD.textSize - 0.5,
    );
    for (const selector of [
      ".meridian-session-screen__head",
      ".meridian-session-screen__composer",
    ]) {
      const box = screen.element(selector).getBoundingClientRect();
      expect(box.left).toBeCloseTo(conversation.left, 0);
      expect(box.width).toBeCloseTo(conversation.width, 0);
      expect(box.right).toBeLessThanOrEqual(blockBox.left + 0.5);
    }
  });

  it("moves no pane on a move's chord in the composer's draft", async () => {
    installPaneChords();
    const screen = await mountScreen();
    const chord = "{Alt>}{Shift>}{ArrowRight}{/Shift}{/Alt}";

    // The first pane is the one focused last, so the chord has a pane to move if it acts.
    act(() => {
      screen.element(".meridian-pane--agents").focus();
      screen.element(".meridian-composer textarea").focus();
    });
    await act(async () => {
      await userEvent.keyboard(chord);
    });
    expect(screen.rowKinds()).toStrictEqual(["agents", "browser"]);

    // Negative control: the same chord on the first pane's frame moves it one place.
    act(() => {
      screen.element(".meridian-pane--agents").focus();
    });
    await act(async () => {
      await userEvent.keyboard(chord);
    });
    expect(screen.rowKinds()).toStrictEqual(["browser", "agents"]);
  });
});

/** The session screen in a box of its own, its saved row of two panes over a stacked terminal. */
async function mountScreen(): Promise<{
  readonly element: (selector: string) => HTMLElement;
  readonly rowKinds: () => readonly string[];
}> {
  installMeridianTokens(document);
  const uiStateStore = memoryStore();
  await saveLayout(uiStateStore, SESSION_ID, ["agents", "browser", "terminal"]);
  const host = document.createElement("div");
  host.style.display = "grid";
  host.style.width = `${String(SCREEN_WIDTH_PX)}px`;
  host.style.height = `${String(SCREEN_HEIGHT_PX)}px`;
  document.body.append(host);
  onTestFinished(() => {
    host.remove();
  });
  await act(async () => {
    render(
      workspaceFor(
        { sessionId: SESSION_ID, store: sessionStore() },
        uiStateStore,
        undefined,
        undefined,
        framedRegistry(),
      ),
      { container: host },
    );
  });
  const element = (selector: string): HTMLElement =>
    host.querySelector<HTMLElement>(selector) ?? expect.fail(`nothing matched ${selector}`);
  await waitFor(() => {
    element(".meridian-pane--browser");
    element(".meridian-composer textarea");
  });
  return {
    element,
    rowKinds: () =>
      [...host.querySelectorAll<HTMLElement>(".meridian-pane-layout__row .meridian-pane")].map(
        (frame) =>
          /meridian-pane--(\S+)/.exec(frame.className)?.[1] ??
          expect.fail("a frame names its kind"),
      ),
  };
}

/** The conversation's body bare, and each pane framed around a body taller than the pane. */
function framedRegistry(): PaneRegistry {
  const registry = new PaneRegistry();
  registry.register({
    kind: "transcript",
    owner: "main-column-test",
    render: () => <p>the conversation</p>,
  });
  for (const kind of ["agents", "browser", "terminal"] as const) {
    registry.register({
      kind,
      owner: "main-column-test",
      render: () => (
        <PaneFrame kind={kind} sessionId={SESSION_ID}>
          <div style={{ blockSize: `${String(BODY_HEIGHT_PX)}px` }}>{kind} body</div>
        </PaneFrame>
      ),
    });
  }
  return registry;
}

/** The pane commands and their chords in a table on this window, as the app composes them. */
function installPaneChords(): void {
  const registry = new CommandRegistry();
  const contributions = new CommandContributionRegistry(registry);
  registerPaneLayoutCommands(contributions);
  // Focus counts as in a pane throughout; the claim is the table's text-entry guard.
  const table = new KeybindingTable({
    registry,
    readContext: () => ({ sessionActive: true, paneFocused: true }),
  });
  table.setBindings(contributions.keyBindings());
  onTestFinished(table.install(window));
  onTestFinished(publishCommandWindow(() => document));
}
