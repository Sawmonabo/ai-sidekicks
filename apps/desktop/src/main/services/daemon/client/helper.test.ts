// The client helper against a fake of the addon's own interface and fakes of Electron's ports:
// what reaches the addon, what reaches main, and what a window is told.

import type { CallOutcome, StreamEvent, SubscribeOutcome } from "@ai-sidekicks/client-sdk";
import { CURRENT_PROTOCOL_VERSION } from "@ai-sidekicks/contracts/jsonrpc/negotiation";
import type { DeviceId } from "@ai-sidekicks/contracts/trust-statement";
import { describe, expect, it, vi } from "vitest";

import {
  serveClientHelper,
  type ClientHelperDaemonClient,
  type ClientHelperParentPort,
  type ClientHelperWindowPort,
} from "./helper.js";
import type { ClientHelperAnswer, ClientHelperRequest } from "#shared/daemon/port-message.js";
import type { FilePathRef } from "#shared/preload-api.js";

import type { ClientHelperToMainMessage, MainToClientHelperMessage } from "./messages.js";

const WINDOW_ID = 3;

/** A daemon client whose calls and streams stay open until the test settles them. */
function fakeDaemonClient() {
  const calls: { addonCallId: number; method: string; paramsJson: string }[] = [];
  const callAnswers = new Map<number, (outcome: CallOutcome) => void>();
  const client = {
    call: vi.fn((addonCallId: number, method: string, paramsJson: string) => {
      calls.push({ addonCallId, method, paramsJson });
      const answered = Promise.withResolvers<CallOutcome>();
      callAnswers.set(addonCallId, answered.resolve);
      return answered.promise;
    }),
    cancelCall: vi.fn<(addonCallId: number) => void>(),
    subscribe: vi.fn(
      (
        _method: string,
        _paramsJson: string,
        _attachments: Buffer[],
        _onEvent: (event: StreamEvent) => void,
      ) =>
        Promise.resolve<SubscribeOutcome>({
          streamId: 7,
          acknowledgment: { json: '{"subscriptionId":"s"}', attachments: [] },
        }),
    ),
    cancelStream: vi.fn<(addonStreamId: number) => void>(),
    close: vi.fn(() => Promise.resolve()),
  } satisfies ClientHelperDaemonClient;
  return { client, calls, callAnswers };
}

/** The helper served on fake ports, connected, with one window's port handed to it. */
function servedHelper() {
  const daemon = fakeDaemonClient();
  const connected = {
    client: daemon.client,
    initializeResponse: {
      compatible: true,
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      deviceId: "device-1" as DeviceId,
    },
  };
  const toMain: ClientHelperToMainMessage[] = [];
  let fromMain: Parameters<ClientHelperParentPort["on"]>[1] | undefined;
  serveClientHelper(
    {
      on: (_event, listener) => {
        fromMain = listener;
      },
      postMessage: (message) => {
        toMain.push(message);
      },
    },
    {
      connect: () => Promise.resolve(connected),
      waitForDaemon: () => Promise.resolve(connected),
    },
  );
  const sendFromMain = (data: MainToClientHelperMessage, ports: ClientHelperWindowPort[] = []) => {
    fromMain!({ data, ports });
  };
  sendFromMain({ kind: "link.connect", presentsToken: true, waitsForStart: false });

  const toWindow: ClientHelperAnswer[] = [];
  let fromWindow: ((messageEvent: { data: unknown }) => void) | undefined;
  let closeWindow: (() => void) | undefined;
  const port: ClientHelperWindowPort = {
    on: (event: "message" | "close", listener: never) => {
      if (event === "message") {
        fromWindow = listener;
      } else {
        closeWindow = listener;
      }
    },
    postMessage: (answer) => {
      toWindow.push(answer);
    },
    start: () => {},
    close: () => {},
  };
  sendFromMain({ kind: "window.port", windowId: WINDOW_ID }, [port]);
  return {
    daemon,
    toMain,
    toWindow,
    sendFromMain,
    sendFromWindow: (request: ClientHelperRequest) => {
      fromWindow!({ data: request });
    },
    closeWindow: () => {
      closeWindow!();
    },
  };
}

describe("the client helper", () => {
  it("refuses a method off the allowlist in the wire's shape without reaching the addon", async () => {
    const helper = servedHelper();
    helper.sendFromWindow({
      kind: "call",
      callId: 1,
      method: "daemon.data.erase",
      params: {},
      attachments: [],
    });
    await vi.waitFor(() => {
      expect(helper.toWindow).toHaveLength(1);
    });
    expect(helper.toWindow[0]).toStrictEqual({
      kind: "call.refused",
      callId: 1,
      refusal: {
        code: -31000,
        message: "The app does not call daemon.data.erase",
        data: { type: "request.methodNotAllowed", category: "invalidArgument" },
      },
    });
    expect(helper.daemon.client.call).not.toHaveBeenCalled();
    expect(helper.toMain.filter((message) => message.kind === "filePaths.swap")).toHaveLength(0);
  });

  it("refuses params that fail the method's check the same way, before the addon", async () => {
    const helper = servedHelper();
    helper.sendFromWindow({
      kind: "call",
      callId: 2,
      method: "presence.read",
      params: [],
      attachments: [],
    });
    await vi.waitFor(() => {
      expect(helper.toWindow).toHaveLength(1);
    });
    expect(helper.toWindow[0]).toStrictEqual({
      kind: "call.refused",
      callId: 2,
      refusal: {
        code: -32602,
        message: "The params of presence.read break its contract",
        data: {
          type: "request.paramsInvalid",
          category: "invalidArgument",
          fields: { issues: [{ path: [], message: 'breaks the schema\'s "type" rule' }] },
        },
      },
    });
    expect(helper.daemon.client.call).not.toHaveBeenCalled();
  });

  it("swaps a window's file tokens through main, so the path reaches the addon", async () => {
    const helper = servedHelper();
    const params = {
      workflowRunId: "0199f0a4-5c2e-7a3b-8c1d-2e3f4a5b6c7d",
      nodeId: "node",
      attempt: 1,
      executionIndex: 0,
      fields: {},
      paths: [{ field: "folder", path: "token-1" }],
      expectedRevision: 0,
    };
    helper.sendFromWindow({
      kind: "call",
      callId: 4,
      method: "workflow.humanForm.submit",
      params,
      attachments: [],
    });
    await vi.waitFor(() => {
      expect(helper.toMain.some((message) => message.kind === "filePaths.swap")).toBe(true);
    });
    const ask = helper.toMain.find((message) => message.kind === "filePaths.swap")!;
    expect(ask).toMatchObject({ windowId: WINDOW_ID, method: "workflow.humanForm.submit", params });
    expect(helper.daemon.client.call).not.toHaveBeenCalled();

    const swapped = { ...params, paths: [{ field: "folder", path: "/Users/me/project" }] };
    helper.sendFromMain({
      kind: "filePaths.swapped",
      askId: ask.kind === "filePaths.swap" ? ask.askId : -1,
      params: swapped,
      readsReply: false,
    });
    await vi.waitFor(() => {
      expect(helper.daemon.calls).toHaveLength(1);
    });
    expect(JSON.parse(helper.daemon.calls[0]!.paramsJson)).toStrictEqual(swapped);
  });

  it("cancels a closed window's streams and calls at the addon", async () => {
    const helper = servedHelper();
    helper.sendFromWindow({
      kind: "stream.open",
      streamId: 5,
      method: "presence.subscribe",
      params: {},
      attachments: [],
    });
    await vi.waitFor(() => {
      expect(helper.toWindow).toContainEqual(expect.objectContaining({ kind: "stream.opened" }));
    });
    helper.sendFromWindow({
      kind: "call",
      callId: 6,
      method: "presence.read",
      params: {},
      attachments: [],
    });
    // A method that carries no file path makes no round trip to main.
    await vi.waitFor(() => {
      expect(helper.daemon.calls).toHaveLength(1);
    });
    expect(helper.toMain.filter((message) => message.kind === "filePaths.swap")).toHaveLength(0);

    helper.closeWindow();
    await vi.waitFor(() => {
      expect(helper.daemon.client.cancelStream).toHaveBeenCalledWith(7);
      expect(helper.daemon.client.cancelCall).toHaveBeenCalledWith(
        helper.daemon.calls[0]!.addonCallId,
      );
    });
    // The call the addon still settles is told to no one: the window has gone.
    helper.daemon.callAnswers.get(helper.daemon.calls[0]!.addonCallId)!({
      reply: { json: "{}", attachments: [] },
    });
    await Promise.resolve();
    expect(helper.toWindow.filter((answer) => answer.kind === "call.served")).toHaveLength(0);
  });

  it("holds a frame behind main's tokens for the file it offers, keeping the frames in order", async () => {
    const helper = servedHelper();
    helper.sendFromWindow({
      kind: "stream.open",
      streamId: 8,
      method: "session.event.subscribe",
      params: { sessionId: "0199f0a4-5c2e-7a3b-8c1d-2e3f4a5b6c7d" },
      attachments: [],
    });
    await vi.waitFor(() => {
      expect(helper.toWindow).toContainEqual(expect.objectContaining({ kind: "stream.opened" }));
    });
    const onEvent = helper.daemon.client.subscribe.mock.calls[0]![3];
    const noticeJson = JSON.stringify({
      kind: "changes",
      changes: [{ event: { type: "session.notice.posted", payload: { file: "/Users/me/a" } } }],
    });
    onEvent({ isEnd: false, value: { json: noticeJson, attachments: [] } });
    onEvent({ isEnd: false, value: { json: '{"kind":"behind"}', attachments: [] } });
    await vi.waitFor(() => {
      expect(helper.toMain.some((message) => message.kind === "filePaths.mint")).toBe(true);
    });
    // The frame after the notice waits for the notice, which waits for main.
    expect(helper.toWindow.filter((answer) => answer.kind === "stream.value")).toHaveLength(0);

    const ask = helper.toMain.find((message) => message.kind === "filePaths.mint")!;
    const token = "token-a" as FilePathRef;
    helper.sendFromMain({
      kind: "filePaths.minted",
      askId: ask.kind === "filePaths.mint" ? ask.askId : -1,
      fileRefs: { "/Users/me/a": token },
    });
    await vi.waitFor(() => {
      expect(helper.toWindow.filter((answer) => answer.kind === "stream.value")).toHaveLength(2);
    });
    expect(helper.toWindow.filter((answer) => answer.kind === "stream.value")).toStrictEqual([
      {
        kind: "stream.value",
        streamId: 8,
        json: noticeJson,
        attachments: [],
        fileRefs: { "/Users/me/a": token },
      },
      { kind: "stream.value", streamId: 8, json: '{"kind":"behind"}', attachments: [] },
    ]);
  });

  it("drops a wait main closed before it settled, closing its client and telling main nothing", async () => {
    const daemon = fakeDaemonClient();
    const toMain: ClientHelperToMainMessage[] = [];
    const waited = Promise.withResolvers<{ client: ClientHelperDaemonClient }>();
    let fromMain: Parameters<ClientHelperParentPort["on"]>[1] | undefined;
    serveClientHelper(
      {
        on: (_event, listener) => {
          fromMain = listener;
        },
        postMessage: (message) => {
          toMain.push(message);
        },
      },
      { connect: () => new Promise(() => undefined), waitForDaemon: () => waited.promise },
    );
    fromMain!({
      data: { kind: "link.connect", presentsToken: true, waitsForStart: true },
      ports: [],
    });
    fromMain!({ data: { kind: "link.close" }, ports: [] });

    waited.resolve({ client: daemon.client });
    await vi.waitFor(() => {
      expect(daemon.client.close).toHaveBeenCalledOnce();
    });
    expect(toMain).toStrictEqual([]);
  });
});
