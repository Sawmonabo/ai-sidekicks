// An in-memory daemon connection answered from a script, main's link over it, and main's bridge
// installed over that link with the page's preload bridge on top, for the suites that drive the
// bridge from the page to the daemon. Each suite mocks `electron` itself.

import type { ClientTransport } from "@ai-sidekicks/client-sdk";
import {
  JSONRPC_VERSION,
  type JsonRpcError,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponseEnvelope,
} from "@ai-sidekicks/contracts/jsonrpc/jsonrpc";
import { vi } from "vitest";

import { appFactsSwitches } from "@shared/app-facts.js";
import { DEFAULT_APPEARANCE_RECORD } from "@shared/appearance.js";
import { lastUsedWindowIdSwitch } from "@shared/window/window-id.js";
import type { DaemonConnection, MainProcessState } from "@shared/daemon-status-topic.js";
import type { PreloadApi } from "@shared/preload-api.js";
import type { DaemonLink } from "../services/daemon/daemon-link.js";

/** An in-memory daemon connection: it answers each request from a script, and can be closed. */
export interface ScriptedConnection extends ClientTransport {
  readonly requests: { readonly method: string; readonly params: unknown }[];
  closeWith(reason: Error): void;
  /** Push one value on a subscription the script acknowledged. */
  notify(subscriptionId: string, value: unknown): void;
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
        method: "$/subscription/notify",
        params: { subscriptionId, value },
      });
    },
    close(): Promise<void> {
      onClose?.(undefined);
      return Promise.resolve();
    },
  };
}

/** The supervisor's report for a link in `connection`'s state. */
export function stateReading(connection: DaemonConnection): MainProcessState {
  return {
    connection,
    negotiation: undefined,
    startedByApp: undefined,
    whileSignedOut: undefined,
    cannotStart: undefined,
  };
}

/** Main's link with a daemon client attached over `connection`, in the state given. */
export async function linkOver(
  connection: ScriptedConnection,
  linkConnection: DaemonConnection = { kind: "connected" },
): Promise<DaemonLink> {
  const { JsonRpcClient } = await import("@ai-sidekicks/client-sdk");
  const { DaemonLink } = await import("../services/daemon/daemon-link.js");
  const link = new DaemonLink();
  link.attach(
    new JsonRpcClient(connection, {
      protocolVersion: "2026-05-01",
      maxQueuedValuesPerSubscription: 16,
    }),
    stateReading(linkConnection),
  );
  return link;
}

/** Main with its bridge installed over `connection`, and the bridge the page holds. */
export async function bridgeOver(connection: ScriptedConnection): Promise<PreloadApi> {
  return bridgeOverLink(await linkOver(connection));
}

/**
 * Main with its bridge installed over `link`, and the bridge the page holds. Main's own files go
 * under `userData`; a suite that writes one passes a folder of its own.
 */
export async function bridgeOverLink(
  link: DaemonLink,
  userData = "/sidekicks-electron-mock/userData",
): Promise<PreloadApi> {
  const { DaemonForwarding } = await import("./daemon.js");
  const { installBridgeHandlers } = await import("./install-bridge-handlers.js");
  const { createPreloadApi } = await import("@preload/api.js");
  const { FilePathRefs } = await import("./file-path-refs.js");

  const log = { write: vi.fn() };
  const filePathRefs = new FilePathRefs();
  installBridgeHandlers({
    userData,
    filePathRefs,
    daemonForwarding: new DaemonForwarding({
      link,
      filePathRefs,
      supervisor: { endService: vi.fn() },
      log,
      now: () => new Date(),
    }),
    supervisor: { requestStart: vi.fn() },
    daemonLink: link,
    log,
    windowContext: {
      appearance: { choose: vi.fn(), record: DEFAULT_APPEARANCE_RECORD },
      openWindows: {
        windowWithId: vi.fn(),
        isConsoleDocument: vi.fn(),
        windowUsedLast: vi.fn(),
        setDefaultSizes: vi.fn(),
      },
    },
  });
  return createPreloadApi([
    ...appFactsSwitches({
      version: "0.0.0",
      platform: "darwin",
      arch: "arm64",
      locale: "en-US",
      physicalMemoryBytes: 17_179_869_184,
    }),
    lastUsedWindowIdSwitch("w-1"),
  ]);
}
