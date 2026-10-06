// The `sidekicks://` link handler over main's real registry of windows and the bridge's read of the
// held request: a link that arrives before the console document listens, from the operating system
// or a command line, is held and handed over once the document reads, and every later one is
// pushed until another console document loads or the renderer's process goes; a request with the
// hidden window closed builds it again, except during a quit, and with the load-failure page
// showing brings that page forward; a refused link routes nothing and its log line holds no part of
// it; and an installed app takes the scheme at every start, logging the app it displaced or the
// system's refusal, while an unpackaged run leaves it alone. `electron` is mocked.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { composeAppLink } from "@ai-sidekicks/contracts/app-link";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { WorkflowRunId } from "@ai-sidekicks/contracts/workflow/run/id";

import { DEFAULT_APPEARANCE_RECORD, MERIDIAN_GROUNDS } from "#shared/appearance.js";
import { BRIDGE_CHANNELS, NAVIGATION_REQUEST_CHANNEL } from "#shared/bridge-channels.js";
import type { NavigationRequest } from "#shared/preload-api.js";
import { createElectronMock } from "#test/helpers/electron/mock/module.js";
import type { MockBaseWindow } from "#test/helpers/electron/mock/window.js";
import { INDEX_URL, loggedMessages, testWindowFrame } from "#test/helpers/electron/mock/readers.js";

const electronMock = createElectronMock();

vi.mock("electron", () => electronMock.moduleExports);

const SESSION_ID = "0199a0c2-7d3e-7b1f-9c4a-8f3a1b2c5d6e" as SessionId;
const WORKFLOW_RUN_ID = "0199a0c2-7d3e-7b1f-9c4a-8f3a1b2c5d6f" as WorkflowRunId;
const SESSION_REQUEST: NavigationRequest = { kind: "session", sessionId: SESSION_ID };
const RUN_REQUEST: NavigationRequest = { kind: "workflowRun", workflowRunId: WORKFLOW_RUN_ID };
const SESSION_LINK = composeAppLink(SESSION_REQUEST);
const RUN_LINK = composeAppLink(RUN_REQUEST);

/** The program a second launch runs, ahead of its arguments. */
const PROGRAM = "/opt/AI Sidekicks/ai-sidekicks";

/** The mocked `app`, with the protocol-client members a case answers otherwise. */
interface MockedApp {
  readonly on: (eventName: string, listener: (...args: never[]) => void) => void;
  readonly setAsDefaultProtocolClient: ReturnType<typeof vi.fn>;
  readonly isDefaultProtocolClient: ReturnType<typeof vi.fn>;
  readonly getApplicationNameForProtocol: ReturnType<typeof vi.fn>;
  readonly quit: () => void;
}

const launchArguments = process.argv;

beforeEach(() => {
  electronMock.reset();
  vi.clearAllMocks();
});

afterEach(() => {
  process.argv = launchArguments;
  vi.restoreAllMocks();
});

/**
 * Main's registry of windows with its lifecycle and the link handler installed on the mocked `app`,
 * as start installs them before ready, on a launch whose command line ends with `commandLine`.
 */
async function startLinkHandler(commandLine: readonly string[] = []) {
  vi.resetModules();
  process.argv = [...launchArguments.slice(0, 1), ...commandLine];
  const { app, screen } = (await import("electron")) as unknown as {
    app: MockedApp;
    screen: never;
  };
  const { OpenWindows } = await import("../windows/registry.js");
  const { installAppLinkHandler } = await import("./app-link.js");
  const { windowAnswers } = await import("../bridge/window.js");
  const { log } = testWindowFrame();
  const openWindows = new OpenWindows({
    placeFile: {
      readSync: () => ({ windowUsedLast: undefined, places: new Map() }),
      writeSync() {},
    },
    screen,
    appearance: {
      ground: MERIDIAN_GROUNDS.light,
      record: DEFAULT_APPEARANCE_RECORD,
      subscribe: () => () => undefined,
    },
    log,
    platform: "darwin",
  });
  openWindows.installLifecycle(app as never);
  installAppLinkHandler({ app: app as never, windows: openWindows, log });
  const readHeld = windowAnswers({
    appearance: { choose: vi.fn(), record: DEFAULT_APPEARANCE_RECORD },
    openWindows,
  })[BRIDGE_CHANNELS.readNavigationRequest];
  return {
    app,
    log,
    openWindows,
    /** The console document reads the request held for it, as its first subscription does. */
    readFromConsoleDocument: () =>
      readHeld({ sender: latestHiddenWindow().contentView.children[0]?.webContents } as never, {}),
  };
}

/** The hidden window built last, which holds the console document. */
function latestHiddenWindow(): MockBaseWindow {
  return (
    electronMock.constructed
      .filter((built) => built.contentView.children[0]?.options.webContents === undefined)
      .at(-1) ?? expect.fail("a hidden window was built")
  );
}

/** What main pushed the console document the hidden window built last holds. */
function sentToConsoleDocument(): readonly { channel: string; value: unknown }[] {
  return latestHiddenWindow().contentView.children[0]?.webContents.sent ?? [];
}

describe("a link", () => {
  it.each([
    {
      arrival: "the operating system, before ready",
      commandLine: [],
      deliver: () => electronMock.emitAppEvent("open-url", SESSION_LINK),
    },
    {
      arrival: "the launch's own command line",
      // Found by its scheme: Chromium's switches sit around it, the last argument among them.
      commandLine: [
        "--user-data-dir=/tmp/profile",
        SESSION_LINK,
        "--original-process-start-time=1",
      ],
      deliver: () => false,
    },
  ])(
    "from $arrival is held until the console document reads it, then handed over once",
    async ({ commandLine, deliver }) => {
      const { openWindows, readFromConsoleDocument } = await startLinkHandler(commandLine);
      // `open-url` is answered as handled, so macOS opens nothing else for it.
      expect(deliver()).toBe(commandLine.length === 0);

      openWindows.openHiddenWindow({ additionalArguments: [] });

      expect(sentToConsoleDocument()).toEqual([]);
      expect(readFromConsoleDocument()).toEqual(SESSION_REQUEST);
      expect(readFromConsoleDocument()).toBeNull();
    },
  );

  it("is pushed once the console document listens, and held again while a reloaded or rebuilt document loads", async () => {
    const { openWindows, readFromConsoleDocument } = await startLinkHandler();
    openWindows.openHiddenWindow({ additionalArguments: [] });
    expect(readFromConsoleDocument()).toBeNull();

    electronMock.emitAppEvent("open-url", RUN_LINK);
    electronMock.emitAppEvent("second-instance", [PROGRAM, SESSION_LINK], "/", {});
    expect(sentToConsoleDocument()).toEqual([
      { channel: NAVIGATION_REQUEST_CHANNEL, value: RUN_REQUEST },
      { channel: NAVIGATION_REQUEST_CHANNEL, value: SESSION_REQUEST },
    ]);

    // A reload replaces the console document, which has not listened yet: only the latest is held.
    latestHiddenWindow().contentView.children[0]?.webContents.emit("did-start-navigation", {
      isMainFrame: true,
      isSameDocument: false,
    });
    electronMock.emitAppEvent("open-url", SESSION_LINK);
    electronMock.emitAppEvent("open-url", RUN_LINK);
    expect(sentToConsoleDocument()).toHaveLength(2);
    expect(readFromConsoleDocument()).toEqual(RUN_REQUEST);

    // The renderer's process goes: a push to the lost document would reach no one, so the request
    // waits for the document main builds in its place on a later task.
    const lostDocument = latestHiddenWindow();
    lostDocument.contentView.children[0]?.webContents.emit(
      "render-process-gone",
      {},
      { reason: "crashed" },
    );
    electronMock.emitAppEvent("open-url", SESSION_LINK);
    expect(sentToConsoleDocument()).toHaveLength(2);
    await vi.waitFor(() => {
      expect(latestHiddenWindow()).not.toBe(lostDocument);
    });
    expect(readFromConsoleDocument()).toEqual(SESSION_REQUEST);
  });

  it("builds the hidden window again once a person closed it, but not during a quit, and brings the load-failure page forward", async () => {
    const { openWindows, readFromConsoleDocument } = await startLinkHandler();
    electronMock.failLoadsContaining(INDEX_URL, new Error("ERR_FILE_NOT_FOUND (-6)"));
    openWindows.openHiddenWindow({ additionalArguments: [] });
    const failurePage = latestHiddenWindow();
    await vi.waitFor(() => {
      expect(failurePage.isVisible()).toBe(true);
    });

    electronMock.emitAppEvent("open-url", SESSION_LINK);
    // The page that says the app could not load comes forward; where a link opens is the console
    // document's call, so main asks it to reopen no window.
    expect(failurePage.focusCount).toBe(1);
    expect(sentToConsoleDocument()).toEqual([]);

    failurePage.close();
    electronMock.emitAppEvent("open-url", RUN_LINK);

    const rebuilt = latestHiddenWindow();
    expect(rebuilt).not.toBe(failurePage);
    expect(readFromConsoleDocument()).toEqual(RUN_REQUEST);

    // During a quit nothing opens: the hidden window, closed first while its document reloads, is
    // not built again for a link.
    rebuilt.contentView.children[0]?.webContents.emit("did-start-navigation", {
      isMainFrame: true,
      isSameDocument: false,
    });
    electronMock.emitAppEvent("before-quit");
    electronMock.emitAppEvent("open-url", SESSION_LINK);
    expect(latestHiddenWindow()).toBe(rebuilt);
  });

  it("not in the one form routes nothing, and its log line holds no part of it", async () => {
    const { openWindows, log, readFromConsoleDocument } = await startLinkHandler();
    const secret = "s3cret-from-the-query";
    const refusedLinks = [
      `${SESSION_LINK}?token=${secret}`,
      `sidekicks://session//${SESSION_ID}`,
      `https://example.com/${SESSION_ID}?token=${secret}`,
    ];

    electronMock.emitAppEvent("open-url", refusedLinks[0]);
    openWindows.openHiddenWindow({ additionalArguments: [] });
    expect(readFromConsoleDocument()).toBeNull();
    electronMock.emitAppEvent("second-instance", [PROGRAM, refusedLinks[1]], "/", {});
    electronMock.emitAppEvent("open-url", refusedLinks[2]);

    expect(sentToConsoleDocument()).toEqual([]);
    const refusals = loggedMessages(log).filter((message) => message.includes("refused"));
    expect(refusals).toHaveLength(refusedLinks.length);
    for (const message of refusals) {
      expect(message).not.toContain(SESSION_ID);
      expect(message).not.toContain(secret);
    }
  });
});

describe("the scheme at start", () => {
  it("is taken from the app that held it, and logged; a refusal is logged as a failure", async () => {
    const electron = (await import("electron")) as unknown as { app: MockedApp };
    electron.app.isDefaultProtocolClient.mockReturnValueOnce(false);
    electron.app.getApplicationNameForProtocol.mockReturnValueOnce("Other Sidekicks");
    const displacing = await startLinkHandler();

    expect(displacing.app.setAsDefaultProtocolClient).toHaveBeenCalledWith("sidekicks");
    expect(displacing.log.write).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "notice",
        message: expect.stringContaining("from Other Sidekicks") as string,
      }),
    );

    electron.app.setAsDefaultProtocolClient.mockReturnValueOnce(false);
    const refused = await startLinkHandler();

    expect(refused.app.setAsDefaultProtocolClient).toHaveBeenCalledTimes(2);
    expect(refused.log.write).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        message: expect.stringContaining("refused") as string,
      }),
    );
  });

  it("is left alone by a development or test run, so the installed app keeps the links", async () => {
    electronMock.setPackaged(false);
    const { app } = await startLinkHandler();

    expect(app.setAsDefaultProtocolClient).not.toHaveBeenCalled();
  });
});
