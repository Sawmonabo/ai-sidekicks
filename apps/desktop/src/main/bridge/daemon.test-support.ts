// A daemon answered from a script behind the real client helper, served in this process, and
// main's side of the helper over it; main's link over that, and main's bridge installed over the
// link with the page's preload bridge on top, for the suites that drive main's calls and the bridge
// from the page to the daemon. Each suite mocks `electron` itself.

import path from "node:path";

import type { JsonRpcError } from "@ai-sidekicks/contracts/jsonrpc/message";
import { vi } from "vitest";

import { appFactsSwitches } from "#shared/app-facts.js";
import { DEFAULT_APPEARANCE_RECORD } from "#shared/appearance.js";
import { lastUsedWindowIdSwitch } from "#shared/window/last-used.js";
import type { DaemonConnection } from "#shared/daemon/status-topic.js";
import type { PreloadApi } from "#shared/preload-api.js";
import {
  serveClientHelper,
  type ClientHelperDaemonClient,
  type ClientHelperWindowPort,
} from "../services/daemon/client/helper.js";
import type {
  ClientHelperToMainMessage,
  MainToClientHelperMessage,
} from "../services/daemon/client/messages.js";
import type {
  ClientHelperProcess,
  ClientHelperUtilityProcess,
} from "../services/daemon/client/process.js";
import { unlinkedState, type DaemonLink } from "../services/daemon/link/status.js";
import type { FilePathRefs } from "./file-path/refs.js";
import type { WindowHandlerContext } from "./window.js";

/** How the script answers one call or subscribe: a result, or a refusal in the wire's shape. */
export type ScriptedAnswer = { readonly result: unknown } | { readonly error: JsonRpcError };

/**
 * A daemon answered from a script: each call and subscribe that reached it, its pushes on a
 * stream it acknowledged, and the exit of the helper in front of it.
 */
export interface ScriptedDaemon {
  readonly requests: { readonly method: string; readonly params: unknown }[];
  /** Push one value on the newest stream of `method` the script acknowledged. */
  notify(method: string, value: unknown): void;
  /** End the newest stream of `method`, refused with `error` where one is given. */
  end(method: string, error?: JsonRpcError): void;
  /** The helper in front of the daemon exits, as a crashed utility process does. */
  exitHelper(): void;
  /** Forks a helper in this process, connected to the scripted daemon. */
  readonly start: () => ClientHelperUtilityProcess;
}

/** A daemon that answers each call and subscribe from `answer`, on a later turn as a socket does. */
export function scriptedDaemon(
  answer: (request: { method: string }) => ScriptedAnswer,
): ScriptedDaemon {
  const requests: { method: string; params: unknown }[] = [];
  const streams = new Map<string, (event: Parameters<StreamListener>[0]) => void>();
  let nextStreamId = 0;
  let exitRunning: (() => void) | undefined;
  const client: ClientHelperDaemonClient = {
    call: async (_callId, method, paramsJson) => {
      const params: unknown = JSON.parse(paramsJson);
      requests.push({ method, params });
      await Promise.resolve();
      const answered = answer({ method });
      return "error" in answered
        ? { error: answered.error }
        : { reply: { json: JSON.stringify(answered.result), attachments: [] } };
    },
    cancelCall: () => undefined,
    subscribe: async (method, paramsJson, _attachments, onEvent) => {
      requests.push({ method, params: JSON.parse(paramsJson) as unknown });
      await Promise.resolve();
      const answered = answer({ method });
      if ("error" in answered) {
        return { error: answered.error };
      }
      streams.set(method, onEvent);
      nextStreamId += 1;
      return {
        streamId: nextStreamId,
        acknowledgment: { json: JSON.stringify(answered.result), attachments: [] },
      };
    },
    cancelStream: () => undefined,
    close: () => Promise.resolve(),
  };
  return {
    requests,
    notify(method, value) {
      streams.get(method)?.({
        value: { json: JSON.stringify(value), attachments: [] },
        isEnd: false,
      });
    },
    end(method, error) {
      streams.get(method)?.(error === undefined ? { isEnd: true } : { isEnd: true, error });
      streams.delete(method);
    },
    exitHelper() {
      exitRunning?.();
    },
    start: () => {
      const helper = inProcessHelper(client);
      exitRunning = helper.exit;
      return helper.utilityProcess;
    },
  };
}

/** The listener a subscribe hands the addon. */
type StreamListener = Parameters<ClientHelperDaemonClient["subscribe"]>[3];

/**
 * The client helper served in this process over `client`: main's end of it as Electron's utility
 * process, each message crossing on a later turn and by structured clone as a real one's does.
 */
function inProcessHelper(client: ClientHelperDaemonClient): {
  readonly utilityProcess: ClientHelperUtilityProcess;
  readonly exit: () => void;
} {
  const messageListeners: ((message: ClientHelperToMainMessage) => void)[] = [];
  const exitListeners: ((code: number) => void)[] = [];
  let fromMain:
    | ((messageEvent: {
        data: MainToClientHelperMessage;
        ports: readonly ClientHelperWindowPort[];
      }) => void)
    | undefined;
  let hasExited = false;
  serveClientHelper(
    {
      on: (_event, listener) => {
        fromMain = listener;
      },
      postMessage: (message) => {
        const cloned = structuredClone(message);
        queueMicrotask(() => {
          if (!hasExited) {
            for (const listener of messageListeners) {
              listener(cloned);
            }
          }
        });
      },
    },
    { connect: () => Promise.resolve({ client }) },
  );
  const exit = (): void => {
    if (hasExited) {
      return;
    }
    hasExited = true;
    for (const listener of exitListeners) {
      listener(1);
    }
  };
  const utilityProcess = {
    postMessage: (message: MainToClientHelperMessage, transfer: unknown[] = []) => {
      const cloned = structuredClone(message);
      queueMicrotask(() => {
        if (!hasExited) {
          fromMain?.({ data: cloned, ports: transfer as ClientHelperWindowPort[] });
        }
      });
    },
    on: (event: "message" | "exit", listener: (argument: never) => void) => {
      if (event === "message") {
        messageListeners.push(listener as (message: ClientHelperToMainMessage) => void);
      } else {
        exitListeners.push(listener as (code: number) => void);
      }
    },
    kill: () => {
      exit();
      return true;
    },
  } as ClientHelperUtilityProcess;
  return { utilityProcess, exit };
}

/** Main's side of the client helper over `daemon`, connected, and main's link holding it. */
export async function linkOver(
  daemon: ScriptedDaemon,
  linkConnection: DaemonConnection = { kind: "connected" },
): Promise<DaemonLink> {
  const { ClientHelperProcess } = await import("../services/daemon/client/process.js");
  const { DaemonLink } = await import("../services/daemon/link/status.js");
  const helperProcess: ClientHelperProcess = new ClientHelperProcess({
    start: daemon.start,
    connect: { kind: "link.connect", isPackaged: false, platform: "linux" },
    answerFilePathAsk: () => {
      throw new Error("No window holds a port in this suite.");
    },
    logWarning: () => undefined,
  });
  const refused = await helperProcess.connect();
  if (refused !== undefined) {
    throw new Error(`The scripted daemon refused the connect: ${refused.message}`);
  }
  const link = new DaemonLink();
  link.attach(helperProcess, unlinkedState(linkConnection));
  return link;
}

/** Main with its bridge installed over `daemon`, and the bridge the page holds. */
export async function bridgeOver(daemon: ScriptedDaemon): Promise<PreloadApi> {
  return bridgeOverLink(await linkOver(daemon));
}

/** A window context whose every member is a stand-in that answers nothing. */
export function idleWindowContext(): WindowHandlerContext {
  return {
    appearance: { choose: vi.fn(), record: DEFAULT_APPEARANCE_RECORD },
    openWindows: {
      windowWithId: vi.fn(),
      documentOfWindow: vi.fn(),
      isConsoleDocument: vi.fn(),
      windowUsedLast: vi.fn(),
      setDefaultSizes: vi.fn(),
      endSafeStart: vi.fn(),
      readNavigationRequest: vi.fn(),
    },
  };
}

/**
 * Main with its bridge installed over `link`, and the bridge the page holds. Main's own files go
 * under `userData`; a suite that writes one passes a folder of its own, a suite that drives the
 * `window` members passes the context they act on, and one that mints a token itself passes the
 * table main keeps them in.
 */
export async function bridgeOverLink(
  link: DaemonLink,
  userData = "/sidekicks-electron-mock/userData",
  windowContext: WindowHandlerContext = idleWindowContext(),
  filePathRefs?: FilePathRefs,
): Promise<PreloadApi> {
  const { installBridgeHandlers } = await import("./install-handlers.js");
  const { createPreloadApi } = await import("#preload/api.js");
  const { FilePathRefs } = await import("./file-path/refs.js");
  const { PASTED_IMAGES_FOLDER_NAME, PastedImages } = await import("./native/file-intake.js");
  const { selectMainOperatingSystem } = await import("../operating-system/selection.js");
  const { AppDiagnosticRelay } = await import("../services/app-diagnostic/relay.js");

  const log = { write: vi.fn() };
  const refs = filePathRefs ?? new FilePathRefs();
  const pastedImages = new PastedImages({
    folder: path.join(userData, PASTED_IMAGES_FOLDER_NAME),
    filePathRefs: refs,
    log,
  });
  installBridgeHandlers({
    userData,
    filePathRefs: refs,
    pastedImages,
    supervisor: { requestStart: vi.fn() },
    helperProcess: { adoptWindowPort: vi.fn() },
    daemonLink: link,
    log,
    appDiagnosticRelay: new AppDiagnosticRelay({ link, log, now: () => new Date() }),
    windowContext,
    // The host's own module, as the handlers write to this machine's disk.
    operatingSystem: selectMainOperatingSystem(process.platform),
  });
  return createPreloadApi([
    ...appFactsSwitches({
      version: "0.0.0",
      platform: "darwin",
      hasPrimarySelection: false,
      arch: "arm64",
      locale: "en-US",
      physicalMemoryBytes: 17_179_869_184,
      regionLocale: "en-US",
      hourCycle: "h12",
    }),
    lastUsedWindowIdSwitch("w-1"),
  ]);
}
