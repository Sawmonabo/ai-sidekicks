// An in-memory daemon connection answered from a script, main's link over it, and main's bridge
// installed over that link with the page's preload bridge on top, for the suites that drive the
// bridge from the page to the daemon. Each suite mocks `electron` itself.

import path from "node:path";

import type { ClientTransport } from "@ai-sidekicks/client-sdk";
import {
  JSONRPC_VERSION,
  type JsonRpcError,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponseEnvelope,
} from "@ai-sidekicks/contracts/jsonrpc/message";
import { CURRENT_PROTOCOL_VERSION } from "@ai-sidekicks/contracts/jsonrpc/negotiation";
import {
  SUBSCRIPTION_END_METHOD,
  SUBSCRIPTION_NOTIFY_METHOD,
  type SubscriptionEndParams,
} from "@ai-sidekicks/contracts/jsonrpc/streaming";
import { vi } from "vitest";

import { appFactsSwitches } from "#shared/app-facts.js";
import { DEFAULT_APPEARANCE_RECORD } from "#shared/appearance.js";
import { lastUsedWindowIdSwitch } from "#shared/window/last-used.js";
import type { DaemonConnection } from "#shared/daemon/status-topic.js";
import type { PreloadApi } from "#shared/preload-api.js";
import { unlinkedState, type DaemonLink } from "../services/daemon/link/status.js";
import type { WindowHandlerContext } from "./window.js";

/** An in-memory daemon connection: it answers each request from a script, and can be closed. */
export interface ScriptedConnection extends ClientTransport {
  readonly requests: { readonly method: string; readonly params: unknown }[];
  closeWith(reason: Error): void;
  /** Push one value on a subscription the script acknowledged. */
  notify(subscriptionId: string, value: unknown): void;
  /** End a subscription the script acknowledged, as the daemon's last frame for it does. */
  end(end: SubscriptionEndParams): void;
}

/** How the script answers one request: a result, or a refusal. */
export type ScriptedAnswer = { readonly result: unknown } | { readonly error: JsonRpcError };

/** A connection that answers each request from `answer`, on a later turn as a socket does. */
export function scriptedConnection(
  answer: (request: JsonRpcRequest) => ScriptedAnswer,
): ScriptedConnection {
  const requests: { method: string; params: unknown }[] = [];
  let deliver: ((message: JsonRpcResponseEnvelope | JsonRpcNotification) => void) | undefined;
  let onClose: ((reason?: Error) => void) | undefined;
  return {
    requests,
    send(envelope): void {
      if (!("id" in envelope)) {
        return;
      }
      requests.push({ method: envelope.method, params: envelope.params });
      const answered = answer(envelope);
      // A socket answers on a later turn, never inside the write.
      queueMicrotask(() => {
        deliver?.({ jsonrpc: JSONRPC_VERSION, id: envelope.id, ...answered });
      });
    },
    onMessage(handler): void {
      deliver = handler;
    },
    onClose(handler): void {
      onClose = handler;
    },
    closeWith(reason): void {
      onClose?.(reason);
    },
    notify(subscriptionId, value): void {
      deliver?.({
        jsonrpc: JSONRPC_VERSION,
        method: SUBSCRIPTION_NOTIFY_METHOD,
        params: { subscriptionId, value },
      });
    },
    end(end): void {
      deliver?.({ jsonrpc: JSONRPC_VERSION, method: SUBSCRIPTION_END_METHOD, params: end });
    },
    close(): Promise<void> {
      onClose?.(undefined);
      return Promise.resolve();
    },
  };
}

/** Main's link with a daemon client attached over `connection`, in the state given. */
export async function linkOver(
  connection: ScriptedConnection,
  linkConnection: DaemonConnection = { kind: "connected" },
): Promise<DaemonLink> {
  const { JsonRpcClient } = await import("@ai-sidekicks/client-sdk");
  const { DaemonLink } = await import("../services/daemon/link/status.js");
  const link = new DaemonLink();
  link.attach(
    new JsonRpcClient(connection, {
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      maxQueuedValuesPerSubscription: 16,
    }),
    unlinkedState(linkConnection),
  );
  return link;
}

/** Main with its bridge installed over `connection`, and the bridge the page holds. */
export async function bridgeOver(connection: ScriptedConnection): Promise<PreloadApi> {
  return bridgeOverLink(await linkOver(connection));
}

/** A window context whose every member is a stand-in that answers nothing. */
export function idleWindowContext(): WindowHandlerContext {
  return {
    appearance: { choose: vi.fn(), record: DEFAULT_APPEARANCE_RECORD },
    openWindows: {
      windowWithId: vi.fn(),
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
 * under `userData`; a suite that writes one passes a folder of its own, and a suite that drives
 * the `window` members passes the context they act on.
 */
export async function bridgeOverLink(
  link: DaemonLink,
  userData = "/sidekicks-electron-mock/userData",
  windowContext: WindowHandlerContext = idleWindowContext(),
): Promise<PreloadApi> {
  const { DaemonForwarding } = await import("./daemon.js");
  const { installBridgeHandlers } = await import("./install-handlers.js");
  const { createPreloadApi } = await import("#preload/api.js");
  const { FilePathRefs } = await import("./file-path/refs.js");
  const { PASTED_IMAGES_FOLDER_NAME, PastedImages } = await import("./native/file-intake.js");

  const log = { write: vi.fn() };
  const filePathRefs = new FilePathRefs();
  const pastedImages = new PastedImages({
    folder: path.join(userData, PASTED_IMAGES_FOLDER_NAME),
    filePathRefs,
    log,
  });
  installBridgeHandlers({
    userData,
    filePathRefs,
    pastedImages,
    daemonForwarding: new DaemonForwarding({
      link,
      filePathRefs,
      pastedImages,
      supervisor: { endService: vi.fn() },
      log,
    }),
    supervisor: { requestStart: vi.fn() },
    daemonLink: link,
    log,
    windowContext,
  });
  return createPreloadApi([
    ...appFactsSwitches({
      version: "0.0.0",
      platform: "darwin",
      arch: "arm64",
      locale: "en-US",
      physicalMemoryBytes: 17_179_869_184,
      regionLocale: "en-US",
      hourCycle: "h12",
    }),
    lastUsedWindowIdSwitch("w-1"),
  ]);
}
