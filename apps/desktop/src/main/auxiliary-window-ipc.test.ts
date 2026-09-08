// The shell's auxiliary-window handlers: what opens, what refuses, and who is told.
//
// Driven through the REGISTERED handler rather than through the registry class, which
// is deliberate and is half of what these cases assert: the defect this module exists
// to fix was that `createAuxiliaryWindow` had exactly one caller and the deck's
// "open in window" control reached no shell in any build. A suite that reached past
// `ipcMain` would exercise the same code and prove nothing about that.
//
// The window factory is NOT mocked. `createAuxiliaryWindow` composes the route,
// validates the descriptor and constructs through `window.ts`'s single locked
// constructor, so a case that stubbed it would assert this module's bookkeeping over
// a window nobody built — and the URL, which is the whole point of carrying the pane's
// context over IPC, would go unread.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { AUXILIARY_WINDOW_CHANNELS } from "@ai-sidekicks/contracts";

import { createElectronMock, type MockBrowserWindow } from "../../test/helpers/electron-mock.js";

const electronMock = createElectronMock();
vi.mock("electron", () => electronMock.moduleExports);

/**
 * A session the route grammar accepts.
 *
 * A canonical UUID rather than a readable stand-in: `createAuxiliaryWindow` validates
 * every id in the descriptor against the shared schema before it builds anything, and
 * a case that used a label would be asserting against the refusal rather than the
 * window.
 */
const SESSION_ID = "6f1b2a4c-9d3e-4f7a-8b12-5c0e7a9d4b31";

/**
 * A second session, for the one property a single session cannot show.
 *
 * Every `DeckLayout` mints its panes from `pane-1`, so the interesting collision is
 * two sessions arriving under one pane id — which needs two sessions to state.
 */
const SECOND_SESSION_ID = "0b7c5e21-4a86-4d19-9f33-1e2d8c6b7a40";

/** The renderer that asked, as `ipcMain` hands it to a handler. */
interface RequestingRenderer {
  readonly sender: MockBrowserWindow["webContents"];
}

/**
 * Install the handlers over a fresh registry and hand back the three of them.
 *
 * Dynamic import per case, with the module registry reset first: the installer mints
 * its registry locally, so a second install over a live `ipcMain` is exactly the
 * duplicate-channel collision the mock now throws on — which is the behaviour, not an
 * obstacle to work around with a shared instance.
 */
async function installedHandlers(): Promise<{
  detachPane: (event: unknown, request: unknown) => unknown;
  focusAuxiliary: (event: unknown, handle: unknown) => unknown;
  closeAuxiliary: (event: unknown, handle: unknown) => unknown;
}> {
  vi.resetModules();
  electronMock.reset();
  const { installAuxiliaryWindowControls } = await import("./auxiliary-window-ipc.js");
  installAuxiliaryWindowControls();
  const read = (channel: string): ((event: unknown, argument: unknown) => unknown) => {
    const handler = electronMock.ipcHandlers.get(channel);
    if (handler === undefined) {
      throw new Error(`no handler registered for ${channel}`);
    }
    return handler as (event: unknown, argument: unknown) => unknown;
  };
  return {
    detachPane: read(AUXILIARY_WINDOW_CHANNELS.detachPane),
    focusAuxiliary: read(AUXILIARY_WINDOW_CHANNELS.focusAuxiliary),
    closeAuxiliary: read(AUXILIARY_WINDOW_CHANNELS.closeAuxiliary),
  };
}

/** A renderer to attribute a request to, and to read the reports it was sent. */
function requestingRenderer(): RequestingRenderer {
  // A constructed window's own `WebContents`, so `send` and `isDestroyed` are the
  // mock's real implementations rather than a second stand-in for them.
  const owner = new (electronMock.moduleExports["BrowserWindow"] as new (options: {
    width: number;
    height: number;
    show: boolean;
    webPreferences: Record<string, unknown>;
  }) => MockBrowserWindow)({ width: 100, height: 100, show: false, webPreferences: {} });
  return { sender: owner.webContents };
}

/** The window this shell opened last, as the mock recorded its construction. */
function lastConstructedWindow(): MockBrowserWindow {
  const constructed = electronMock.constructed.at(-1);
  if (constructed === undefined) {
    throw new Error("no window was constructed");
  }
  return constructed;
}

beforeEach(() => {
  electronMock.reset();
});

describe("the shell's detach handler", () => {
  it("opens exactly one window at the pane's own route and answers with its handle", async () => {
    const { detachPane } = await installedHandlers();
    const renderer = requestingRenderer();
    const before = electronMock.constructed.length;

    const handle = detachPane(renderer, {
      paneId: "pane-timeline-1",
      route: "timeline",
      sessionId: SESSION_ID,
    });

    expect(electronMock.constructed.length).toBe(before + 1);
    expect(handle).toStrictEqual({ windowId: "auxiliary-window-1" });
    // The route the deck resolved, formatted by the shared grammar and carrying the
    // handle the deck was just given — which is what lets that window address the
    // shell about itself.
    expect(lastConstructedWindow().loadedUrls.at(-1)).toContain(
      `#/window/timeline/${SESSION_ID}/auxiliary-window-1`,
    );
  });

  it("answers a second detach of one pane with the window it is already in", async () => {
    // A pane's body cannot be in two windows at once. Minting a second would orphan
    // the first and leave the deck addressing a window nobody can reach.
    const { detachPane } = await installedHandlers();
    const renderer = requestingRenderer();
    const request = { paneId: "pane-timeline-1", route: "timeline", sessionId: SESSION_ID };

    const first = detachPane(renderer, request);
    const openedAfterFirst = electronMock.constructed.length;
    const second = detachPane(renderer, request);

    expect(second).toStrictEqual(first);
    expect(electronMock.constructed.length).toBe(openedAfterFirst);
    // And it is brought forward, which is the whole of what a second press should do.
    expect(lastConstructedWindow().focusCount).toBe(1);
  });

  it("opens a window per session for one pane id, rather than another session's window", async () => {
    // This registry is one registry for the whole application and every deck mints its
    // panes from `pane-1`, so two sessions' first panes arrive under one name. Keyed on
    // that name alone the second detach was answered with the FIRST session's window and
    // brought it forward, and the second deck then suppressed its own pane in favour of
    // a window showing a session it is not about.
    const { detachPane } = await installedHandlers();
    const renderer = requestingRenderer();

    const first = detachPane(renderer, {
      paneId: "pane-1",
      route: "timeline",
      sessionId: SESSION_ID,
    });
    const firstWindow = lastConstructedWindow();
    const openedAfterFirst = electronMock.constructed.length;
    const second = detachPane(renderer, {
      paneId: "pane-1",
      route: "timeline",
      sessionId: SECOND_SESSION_ID,
    });

    expect(second).toStrictEqual({ windowId: "auxiliary-window-2" });
    expect(second).not.toStrictEqual(first);
    expect(electronMock.constructed.length).toBe(openedAfterFirst + 1);
    expect(lastConstructedWindow().loadedUrls.at(-1)).toContain(
      `#/window/timeline/${SECOND_SESSION_ID}/auxiliary-window-2`,
    );
    // And the first window stays where it was: a request that is not about it must not
    // pull it in front of the person who is looking at something else.
    expect(firstWindow.focusCount).toBe(0);
  });

  it("refuses a pane kind that is not an auxiliary route, before anything is built", async () => {
    // A route arrives over IPC and is untrusted. The refusal is about the DESCRIPTOR,
    // which is only true while no window has been constructed for it.
    const { detachPane } = await installedHandlers();
    const renderer = requestingRenderer();
    const before = electronMock.constructed.length;

    expect(() => detachPane(renderer, { paneId: "pane-approvals-1", route: "approvals" })).toThrow(
      /unknown route/,
    );

    expect(electronMock.constructed.length).toBe(before);
  });

  it("refuses an unheld handle on both controls a placeholder offers", async () => {
    const { focusAuxiliary, closeAuxiliary } = await installedHandlers();
    const renderer = requestingRenderer();

    expect(() => focusAuxiliary(renderer, { windowId: "auxiliary-window-9" })).toThrow(
      /no auxiliary window/,
    );
    expect(() => closeAuxiliary(renderer, { windowId: "auxiliary-window-9" })).toThrow(
      /no auxiliary window/,
    );
  });
});

describe("what the shell tells the renderer when a window stops being open", () => {
  it("reports the return, to the renderer that asked and to no other", async () => {
    const { detachPane } = await installedHandlers();
    const renderer = requestingRenderer();
    const bystander = requestingRenderer();
    detachPane(renderer, { paneId: "pane-timeline-1", route: "timeline", sessionId: SESSION_ID });

    lastConstructedWindow().onceHandlers.get("closed")?.();

    expect(renderer.sender.sent).toStrictEqual([
      {
        channel: AUXILIARY_WINDOW_CHANNELS.paneReturn,
        payload: { windowId: "auxiliary-window-1", paneId: "pane-timeline-1" },
      },
    ]);
    // A report broadcast to every window would tell a deck that a pane it does not
    // hold has come back.
    expect(bystander.sender.sent).toStrictEqual([]);
  });

  it("reports a crash instead, carrying the reason the renderer gave", async () => {
    // The two endings are one report and not two: the factory destroys a window whose
    // renderer died, so a crash reaches `closed` as well, and which report goes out is
    // decided by whether a reason was recorded first.
    const { detachPane } = await installedHandlers();
    const renderer = requestingRenderer();
    detachPane(renderer, { paneId: "pane-timeline-1", route: "timeline", sessionId: SESSION_ID });
    const opened = lastConstructedWindow();

    opened.webContents.handlers.get("render-process-gone")?.(
      // The event object the production listener ignores, and the details it reads.
      ...([{}, { reason: "crashed" }] as never[]),
    );
    opened.onceHandlers.get("closed")?.();

    expect(renderer.sender.sent).toHaveLength(1);
    expect(renderer.sender.sent[0]?.channel).toBe(AUXILIARY_WINDOW_CHANNELS.paneError);
    // NAMED BY WINDOW AS WELL AS BY PANE, exactly as the return is. That renderer holds
    // every session's hand-off and each of its decks mints a `pane-1`, so a crash report
    // named by the pane alone reached sessions whose own windows were still open — and
    // they took their placeholders down over somebody else's crash.
    expect(renderer.sender.sent[0]?.payload).toStrictEqual({
      windowId: "auxiliary-window-1",
      paneId: "pane-timeline-1",
      reason: "The window's renderer stopped (crashed).",
    });
  });

  it("names the crashed window, so two sessions' reports are told apart", async () => {
    // Both decks hold a `pane-1`, so the pane id is not what tells the reports apart:
    // without the handle, a hand-off matching on the pane alone reads the second
    // session's crash as its own.
    const { detachPane } = await installedHandlers();
    const renderer = requestingRenderer();
    detachPane(renderer, { paneId: "pane-1", route: "timeline", sessionId: SESSION_ID });
    detachPane(renderer, { paneId: "pane-1", route: "timeline", sessionId: SECOND_SESSION_ID });
    const second = lastConstructedWindow();

    second.webContents.handlers.get("render-process-gone")?.(
      ...([{}, { reason: "crashed" }] as never[]),
    );
    second.onceHandlers.get("closed")?.();

    expect(renderer.sender.sent).toStrictEqual([
      {
        channel: AUXILIARY_WINDOW_CHANNELS.paneError,
        payload: {
          windowId: "auxiliary-window-2",
          paneId: "pane-1",
          reason: "The window's renderer stopped (crashed).",
        },
      },
    ]);
  });

  it("says nothing to a renderer that has gone, rather than throwing into the close", async () => {
    const { detachPane } = await installedHandlers();
    const renderer = requestingRenderer();
    detachPane(renderer, { paneId: "pane-timeline-1", route: "timeline", sessionId: SESSION_ID });
    renderer.sender.destroy();

    expect(() => lastConstructedWindow().onceHandlers.get("closed")?.()).not.toThrow();
  });

  it("forgets the window it reported, so the pane can be detached into a fresh one", async () => {
    // The record has to go with the report. A window kept after it closed would answer
    // the next detach of that pane with a handle nothing is behind.
    const { detachPane } = await installedHandlers();
    const renderer = requestingRenderer();
    const request = { paneId: "pane-timeline-1", route: "timeline", sessionId: SESSION_ID };
    detachPane(renderer, request);
    lastConstructedWindow().onceHandlers.get("closed")?.();

    const reopened = detachPane(renderer, request);

    expect(reopened).toStrictEqual({ windowId: "auxiliary-window-2" });
  });
});

describe("the registration itself", () => {
  it("registers all three channels, and refuses a second installation", async () => {
    // Idempotency by construction rather than by a guard: `ipcMain.handle` throws on a
    // second registration for one channel, so a second call is a startup defect that
    // is reported rather than a silently stacked listener.
    await installedHandlers();
    const { installAuxiliaryWindowControls } = await import("./auxiliary-window-ipc.js");

    expect([...electronMock.ipcHandlers.keys()]).toStrictEqual([
      AUXILIARY_WINDOW_CHANNELS.detachPane,
      AUXILIARY_WINDOW_CHANNELS.focusAuxiliary,
      AUXILIARY_WINDOW_CHANNELS.closeAuxiliary,
    ]);
    expect(() => {
      installAuxiliaryWindowControls();
    }).toThrow(/second handler/);
  });
});
