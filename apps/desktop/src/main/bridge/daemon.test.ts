// A daemon call goes from the page's bridge, through main, to the daemon client main holds, and
// back; a refusal comes back as one the renderer reads, with nothing of main's connection in it.
// A page's subscriptions are canceled on the daemon when it loads a new document or goes, and one
// that ends while the page holds it is told to the page. The status topic speaks with no service
// linked. A call that ends work goes only over a link that reads connected with a compatible
// handshake. A failure the operating system raised crosses by its code, with no path in it.

import { randomBytes, randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { inspect } from "node:util";

import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/jsonrpc";
import type { SubscriptionId } from "@ai-sidekicks/contracts/jsonrpc/streaming";
import { MACHINE_SETTINGS_DEFAULTS } from "@ai-sidekicks/contracts/machine-settings";
import type { SessionId } from "@ai-sidekicks/contracts/session/session";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { normalizeWireRejection } from "#renderer/lib/wire/rejection.js";
import { callDaemon } from "#renderer/services/daemon/daemon-reply.js";
import type { PlatformBridge } from "#renderer/services/platform/platform-bridge.js";
import type { FilePathRef } from "#shared/preload-api.js";
import { createElectronMock } from "#test/helpers/electron/mock/electron-mock.js";
import type { DaemonConnection, MainProcessState } from "#shared/daemon/daemon-status-topic.js";
import { unlinkedState } from "../services/daemon/daemon-link.js";
import type { DaemonSubscriber } from "./daemon.js";
import { FilePathRefs } from "./file-path/file-path-refs.js";
import { pageOwner } from "./file-path/file-path-refs.test-support.js";
import {
  bridgeOver,
  bridgeOverLink,
  linkOver,
  scriptedConnection,
  type ScriptedConnection,
} from "./daemon.test-support.js";

const electronMock = createElectronMock();

vi.mock("electron", () => electronMock.moduleExports);

const SESSION_ID = "00000000-0000-4000-8000-000000000001" as SessionId;

/** The page a call comes from. */
const PAGE = pageOwner(1);

/** A `presence.read` reply on its contract: no device has a window in front. */
const NO_DEVICES = { devices: [] };

/** What main presents on its own connection to the daemon; it must never reach the page. */
const SESSION_TOKEN = randomBytes(32).toString("hex");

/** A page main can be told has navigated to a new document, or gone. */
function pageThatCanGo(): DaemonSubscriber & { navigate(): void; destroy(): void } {
  const navigateListeners: (() => void)[] = [];
  const destroyedListeners: (() => void)[] = [];
  return {
    id: 1,
    send: vi.fn(),
    on: (_event, listener) => navigateListeners.push(listener),
    once: (_event, listener) => destroyedListeners.push(listener),
    navigate: () => {
      for (const listener of navigateListeners) {
        listener();
      }
    },
    destroy: () => {
      for (const listener of destroyedListeners.splice(0)) {
        listener();
      }
    },
  };
}

/** The daemon subscriptions main has canceled on `connection`, in order. */
function canceledOn(connection: ScriptedConnection): unknown[] {
  return connection.requests
    .filter((request) => request.method === "$/subscription/cancel")
    .map((request) => (request.params as { readonly subscriptionId: unknown }).subscriptionId);
}

/** What a call rejected with; fails the test if it was served. */
async function rejectionOf(call: Promise<unknown>): Promise<unknown> {
  return call.then(
    (served) => {
      throw new Error(`the call was served: ${inspect(served)}`);
    },
    (rejection: unknown) => rejection,
  );
}

beforeEach(() => {
  electronMock.reset();
  vi.resetModules();
});

describe("the daemon's wire through main", () => {
  it("carries a call from the page's bridge to the daemon client and its result back", async () => {
    const connection = scriptedConnection((request) =>
      request.method === "presence.read"
        ? { result: NO_DEVICES }
        : { error: { code: JsonRpcErrorCode.MethodNotFound, message: "Method not found" } },
    );
    const bridge = await bridgeOver(connection);

    await expect(bridge.daemon.call("presence.read", {})).resolves.toEqual({ value: NO_DEVICES });
    expect(connection.requests).toEqual([{ method: "presence.read", params: {} }]);
  });

  it("hands the page a token for each path a served reply offers, and opens the path by it", async () => {
    const memoryFile = "/Users/person/.claude/projects/app/CLAUDE.md";
    const memoryFolder = "/Users/person/.claude/projects/app/memory";
    const memory = {
      sessionId: SESSION_ID,
      home: "/Users/person/.claude",
      autoMemory: { enabled: true },
      entries: [
        { path: memoryFile, kind: "file" },
        { path: memoryFolder, kind: "folder" },
      ],
    };
    // No editor chosen, so `Open` goes to the system's default for the file.
    const connection = scriptedConnection((request) =>
      request.method === "session.memoryRead"
        ? { result: memory }
        : { result: { settings: MACHINE_SETTINGS_DEFAULTS } },
    );
    // The preload's bridge as the page holds it; `callDaemon` reads only its daemon wire.
    const bridge = (await bridgeOver(connection)) as PlatformBridge;

    const reply = await callDaemon(bridge, "session.memoryRead", { sessionId: SESSION_ID });
    if (reply.status !== "served") {
      throw new Error(`the read was refused: ${reply.refusal.detail}`);
    }
    expect(reply.value).toEqual(memory);
    const fileRefs = reply.fileRefs ?? {};
    expect(Object.keys(fileRefs).sort()).toEqual([memoryFile, memoryFolder].sort());
    for (const [path, ref] of Object.entries(fileRefs)) {
      expect(ref).not.toContain(path);
    }

    await bridge.native.openInEditor(fileRefs[memoryFile] as FilePathRef);
    expect(electronMock.pathOpens).toEqual([memoryFile]);

    // Negative control: the path itself opens nothing.
    await expect(bridge.native.openInEditor(memoryFile as FilePathRef)).rejects.toThrow();
    expect(electronMock.pathOpens).toEqual([memoryFile]);
  });

  it("sends nothing for a call off its contract, or to a method the app does not call", async () => {
    const { DaemonForwarding } = await import("./daemon.js");
    const connection = scriptedConnection(() => ({ result: NO_DEVICES }));
    const forwarding = new DaemonForwarding({
      link: await linkOver(connection),
      filePathRefs: new FilePathRefs(),
      supervisor: { endService: vi.fn() },
      log: { write: vi.fn() },
      now: () => new Date(),
    });

    await expect(
      forwarding.call(PAGE, { method: "presence.read", params: { deviceId: "everyone" } }),
    ).resolves.toMatchObject({ outcome: "failed" });
    await expect(
      forwarding.call(PAGE, { method: "session.attachmentAdd", params: {} }),
    ).resolves.toEqual({
      outcome: "failed",
      message: "The app does not call session.attachmentAdd.",
    });
    expect(connection.requests).toEqual([]);

    // Negative control: the same method on its contract goes.
    await expect(forwarding.call(PAGE, { method: "presence.read", params: {} })).resolves.toEqual({
      outcome: "served",
      value: NO_DEVICES,
    });
  });

  it("returns a refusal the renderer reads, carrying nothing of main's connection", async () => {
    const connection = scriptedConnection(() => ({
      error: {
        code: JsonRpcErrorCode.InvalidParams,
        message: "No session has that id.",
        data: { type: "session.not_found", fields: { retryAfter: 5 } },
      },
    }));
    const bridge = await bridgeOver(connection);

    const refused = await rejectionOf(
      bridge.daemon.call("session.read", { sessionId: SESSION_ID }),
    );
    const refusal = normalizeWireRejection("daemon-call", refused);
    expect(refusal).toMatchObject({
      origin: "daemon-call",
      code: "session.not_found",
      detail: "No session has that id.",
    });
    expect(refusal.retry).toBeDefined();

    // The connection drops with its handshake, token and all, in the reason's cause.
    connection.closeWith(
      new Error("The daemon closed the connection.", {
        cause: new Error(`daemon.hello presented ${SESSION_TOKEN}`),
      }),
    );
    const failed = await rejectionOf(bridge.daemon.call("session.read", { sessionId: SESSION_ID }));
    expect(normalizeWireRejection("daemon-call", failed).detail).toBe(
      "Transport closed: The daemon closed the connection.",
    );
    for (const crossed of [refused, failed]) {
      expect(inspect(crossed, { depth: null, showHidden: true })).not.toContain(SESSION_TOKEN);
    }
  });

  it("says a link the operating system broke by its code, naming no path", async () => {
    const connection = scriptedConnection(() => ({ result: NO_DEVICES }));
    const bridge = await bridgeOver(connection);
    const socketPath = "/Users/someone/Library/Application Support/sidekicks/daemon.sock";

    connection.closeWith(
      Object.assign(new Error(`read ECONNRESET ${socketPath}`), {
        syscall: "read",
        code: "ECONNRESET",
      }),
    );
    const failed = await rejectionOf(bridge.daemon.call("presence.read", {}));

    expect(normalizeWireRejection("daemon-call", failed).detail).toBe(
      "presence.read failed (ECONNRESET).",
    );
    expect(inspect(failed, { depth: null, showHidden: true })).not.toContain(socketPath);
  });

  it("cancels a page's subscriptions on the daemon when it navigates or goes", async () => {
    const daemonSubscriptionIds = [randomUUID(), randomUUID(), randomUUID()];
    const opened = [...daemonSubscriptionIds];
    const connection = scriptedConnection((request) =>
      request.method === "$/subscription/cancel"
        ? { result: { canceled: true } }
        : { result: { subscriptionId: opened.shift() } },
    );
    const { DaemonForwarding } = await import("./daemon.js");
    const log = { write: vi.fn() };
    const forwarding = new DaemonForwarding({
      link: await linkOver(connection),
      filePathRefs: new FilePathRefs(),
      supervisor: { endService: vi.fn() },
      log,
      now: () => new Date(),
    });
    const page = pageThatCanGo();
    const openFor = (): unknown =>
      forwarding.open(page, {
        subscriptionId: randomUUID(),
        event: "session.subscribe",
        params: { sessionId: SESSION_ID },
      });

    expect([openFor(), openFor()]).toEqual([{ outcome: "opened" }, { outcome: "opened" }]);
    await setImmediate();
    expect(canceledOn(connection)).toEqual([]);

    page.navigate();
    await setImmediate();
    expect(canceledOn(connection)).toEqual(daemonSubscriptionIds.slice(0, 2));

    expect(openFor()).toEqual({ outcome: "opened" });
    await setImmediate();
    page.destroy();
    await setImmediate();
    expect(canceledOn(connection)).toEqual(daemonSubscriptionIds);
    expect(log.write).not.toHaveBeenCalled();
  });
});

describe("how a subscription ends, and the status topic", () => {
  it("tells the page how a held subscription ended, and says nothing for one it closed", async () => {
    const refusal = {
      code: JsonRpcErrorCode.InvalidParams,
      message: "That cursor is gone.",
      data: { type: "event.cursor_unresolvable" },
    };
    const connection = scriptedConnection((request) => {
      if (request.method === "$/subscription/cancel") {
        return { result: { canceled: true } };
      }
      const { afterCursor } = request.params as { readonly afterCursor?: string };
      return afterCursor === undefined
        ? { result: { subscriptionId: randomUUID() } }
        : { error: refusal };
    });
    const bridge = await bridgeOver(connection);
    const ends: unknown[] = [];
    const subscribe = (params: { sessionId: SessionId; afterCursor?: string }): (() => void) =>
      bridge.daemon.subscribe(
        "session.subscribe",
        params as never,
        () => undefined,
        (end) => ends.push(end),
      );

    const closedByThePage = subscribe({ sessionId: SESSION_ID });
    subscribe({ sessionId: SESSION_ID, afterCursor: "cursor-gone" });
    await setImmediate();
    expect(ends).toEqual([{ reason: "refused", refusal }]);

    closedByThePage();
    subscribe({ sessionId: SESSION_ID });
    await setImmediate();
    connection.closeWith(new Error("The daemon closed the connection."));
    await setImmediate();
    expect(ends).toEqual([
      { reason: "refused", refusal },
      { reason: "failed", message: "Transport closed: The daemon closed the connection." },
    ]);
  });

  it("ends the page's stream on the daemon's end frame, completed or refused as a call is", async () => {
    const refusal = {
      code: JsonRpcErrorCode.InvalidParams,
      message: "That cursor is gone.",
      data: { type: "event.cursor_unresolvable" },
    };
    const daemonIds = [randomUUID(), randomUUID()] as SubscriptionId[];
    const acknowledged = [...daemonIds];
    const connection = scriptedConnection(() => ({
      result: { subscriptionId: acknowledged.shift() },
    }));
    const bridge = await bridgeOver(connection);
    const values: unknown[] = [];
    const ends: unknown[] = [];
    for (let i = 0; i < 2; i++) {
      bridge.daemon.subscribe(
        "session.subscribe",
        { sessionId: SESSION_ID } as never,
        (value) => values.push(value),
        (end) => ends.push(end),
      );
    }
    await setImmediate();
    const [completing, refusing] = daemonIds as [SubscriptionId, SubscriptionId];

    connection.notify(completing, { sequence: 1 });
    connection.end({ subscriptionId: completing, reason: "completed" });
    await setImmediate();
    // The value queued ahead of the end reaches the page first.
    expect(values).toEqual([{ sequence: 1 }]);
    expect(ends).toEqual([{ reason: "completed" }]);

    connection.end({ subscriptionId: refusing, reason: "refused", error: refusal });
    await setImmediate();
    expect(ends).toEqual([{ reason: "completed" }, { reason: "refused", refusal }]);
    // The page holds neither any longer, so closing them sends no cancel.
    expect(canceledOn(connection)).toEqual([]);
  });

  it("delivers the link's state from before any service answers, the current one first", async () => {
    const { DaemonLink } = await import("../services/daemon/daemon-link.js");
    const link = new DaemonLink();
    const bridge = await bridgeOverLink(link);
    const delivered: MainProcessState[] = [];

    const close = bridge.daemon.subscribe("daemon.status", {}, (state) => delivered.push(state));
    link.report(unlinkedState({ kind: "starting" }));
    close();
    link.report(unlinkedState({ kind: "degraded", attemptLimit: 5, lastError: undefined }));

    expect(delivered.map((state) => state.connection.kind)).toEqual(["connecting", "starting"]);
  });
});

describe("the calls that end work", () => {
  const accepted = { accepted: true } as const;

  it("refuses daemon.stop and daemon.restart unless the link reads connected, sending nothing", async () => {
    const { DaemonForwarding } = await import("./daemon.js");
    const unlinkedStates: DaemonConnection[] = [
      { kind: "connecting" },
      { kind: "starting" },
      { kind: "transient_disconnect", attempt: 1, attemptLimit: 5 },
      { kind: "unknown", lastError: "the frame broke" },
      { kind: "degraded", attemptLimit: 5, lastError: undefined },
      { kind: "stopped" },
    ];
    for (const state of unlinkedStates) {
      const connection = scriptedConnection(() => ({ result: accepted }));
      const link = await linkOver(connection);
      link.detach(unlinkedState(state));
      const forwarding = new DaemonForwarding({
        link,
        filePathRefs: new FilePathRefs(),
        supervisor: { endService: vi.fn() },
        log: { write: vi.fn() },
        now: () => new Date(),
      });
      for (const method of ["daemon.stop", "daemon.restart"]) {
        await expect(forwarding.call(PAGE, { method, params: {} })).resolves.toStrictEqual({
          outcome: "refused",
          refusal: {
            code: JsonRpcErrorCode.InternalError,
            message: "The background service is not connected.",
            data: { type: "transport.unavailable", fields: { reason: state.kind } },
          },
        });
      }
      expect(connection.requests).toStrictEqual([]);
    }
  });

  it("refuses them over a link whose handshake was refused, and still forwards a read", async () => {
    const { DaemonForwarding } = await import("./daemon.js");
    const connection = scriptedConnection(() => ({ result: NO_DEVICES }));
    const forwarding = new DaemonForwarding({
      link: await linkOver(connection, { kind: "version-incompatible" }),
      filePathRefs: new FilePathRefs(),
      supervisor: { endService: vi.fn() },
      log: { write: vi.fn() },
      now: () => new Date(),
    });

    await expect(
      forwarding.call(PAGE, { method: "daemon.restart", params: {} }),
    ).resolves.toMatchObject({
      outcome: "refused",
      refusal: {
        code: JsonRpcErrorCode.InvalidRequest,
        data: { type: "protocol.version_mismatch" },
      },
    });
    await expect(forwarding.call(PAGE, { method: "presence.read", params: {} })).resolves.toEqual({
      outcome: "served",
      value: NO_DEVICES,
    });
    expect(connection.requests.map((request) => request.method)).toStrictEqual(["presence.read"]);
  });

  it("negative control: hands both to the supervisor over a connected link, answering its reply", async () => {
    const { DaemonForwarding } = await import("./daemon.js");
    const connection = scriptedConnection(() => ({ result: accepted }));
    const supervisor = { endService: vi.fn(() => Promise.resolve(accepted)) };
    const forwarding = new DaemonForwarding({
      link: await linkOver(connection),
      filePathRefs: new FilePathRefs(),
      supervisor,
      log: { write: vi.fn() },
      now: () => new Date(),
    });

    await expect(forwarding.call(PAGE, { method: "daemon.restart", params: {} })).resolves.toEqual({
      outcome: "served",
      value: accepted,
    });
    await expect(forwarding.call(PAGE, { method: "daemon.stop", params: {} })).resolves.toEqual({
      outcome: "served",
      value: accepted,
    });
    await expect(
      forwarding.call(PAGE, { method: "daemon.stop", params: { force: true } }),
    ).resolves.toEqual({
      outcome: "failed",
      message: "The daemon.stop request does not match its contract.",
    });
    expect(supervisor.endService.mock.calls).toStrictEqual([["daemon.restart"], ["daemon.stop"]]);
    // The supervisor sends the flush and the request itself; nothing goes around it.
    expect(connection.requests).toStrictEqual([]);
  });
});
