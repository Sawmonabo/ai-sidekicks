// The page's daemon wire over its port to the client helper, with the helper's end played by the
// test: a helper that exits mid-call fails that call once and the next call rides the new port, and
// a stream the page held ends as failed and reopens on the new port from the cursor its owner kept,
// with nothing drawn while no port is held.

import { describe, expect, it, vi } from "vitest";

import { DAEMON_PORT_MESSAGE } from "#shared/bridge-channels.js";
import type { DaemonSubscriptionEnd } from "#shared/daemon/forwarding.js";
import type { ClientHelperAnswer, ClientHelperRequest } from "#shared/daemon/port-message.js";
import { NOT_ANSWERING_MESSAGE } from "#shared/daemon/status-topic.js";
import { DaemonPortClient, type DaemonPort, type DaemonPortWindow } from "./daemon-port-client.js";

/** The helper's end of one port: what the page sent on it, how to answer, and its close. */
interface HelperEnd {
  readonly received: ClientHelperRequest[];
  answer(answer: ClientHelperAnswer): void;
  /** The helper exits: the page's end closes. */
  close(): void;
}

/** A page whose preload hands a new port at each ask, and the helper's end of each. */
function pageWithHelper(): {
  readonly client: DaemonPortClient;
  readonly helperEnds: HelperEnd[];
  readonly openPort: ReturnType<typeof vi.fn>;
} {
  const helperEnds: HelperEnd[] = [];
  let onWindowMessage: Parameters<DaemonPortWindow["addEventListener"]>[1] | undefined;
  const page: DaemonPortWindow = {
    addEventListener: (_type, listener) => {
      onWindowMessage = listener;
    },
  };
  const openPort = vi.fn(() => {
    const received: ClientHelperRequest[] = [];
    const port: DaemonPort = {
      onmessage: null,
      onclose: null,
      postMessage: (request) => {
        received.push(structuredClone(request));
      },
      start: () => undefined,
    };
    helperEnds.push({
      received,
      answer: (answer) => port.onmessage?.({ data: structuredClone(answer) }),
      close: () => port.onclose?.(),
    });
    // The preload posts the page's end to the page's own window, delivered on a later turn.
    queueMicrotask(() => {
      onWindowMessage?.({ source: page, data: DAEMON_PORT_MESSAGE, ports: [port] });
    });
  });
  return { client: new DaemonPortClient({ openPort }, page), helperEnds, openPort };
}

describe("the page's port to the client helper", () => {
  it("fails a call the exited helper held once, and the next call rides the new port", async () => {
    const { client, helperEnds, openPort } = pageWithHelper();
    const first = client.call("presence.read", {});
    const firstOutcome = first.then(
      () => "served",
      (failure: unknown) => failure,
    );
    await vi.waitFor(() => {
      expect(helperEnds[0]?.received).toHaveLength(1);
    });

    helperEnds[0]?.close();
    // Closed a second time, as a late close event would, it fails nothing again.
    helperEnds[0]?.close();
    expect(await firstOutcome).toStrictEqual(new Error(NOT_ANSWERING_MESSAGE));
    expect(openPort).toHaveBeenCalledTimes(2);

    const second = client.call("presence.read", {});
    await vi.waitFor(() => {
      expect(helperEnds[1]?.received).toHaveLength(1);
    });
    const request = helperEnds[1]?.received[0];
    if (request?.kind !== "call") {
      throw new Error("expected the call on the new port");
    }
    helperEnds[1]?.answer({
      kind: "call.served",
      callId: request.callId,
      json: '{"devices":[]}',
      attachments: [],
    });
    await expect(second).resolves.toStrictEqual({ value: { devices: [] } });
    // The old port carried nothing more.
    expect(helperEnds[0]?.received).toHaveLength(1);
  });

  it("ends a held stream as failed on a restart, and its reopen rides the new port from the kept cursor", async () => {
    const { client, helperEnds } = pageWithHelper();
    const drawn: unknown[] = [];
    const ends: DaemonSubscriptionEnd[] = [];
    let keptCursor: string | undefined;
    // The stream's owner keeps the last cursor it drew and reopens after it once the stream ends.
    const open = (): void => {
      client.subscribe(
        "session.subscribe",
        keptCursor === undefined ? { sessionId: "s" } : { sessionId: "s", afterCursor: keptCursor },
        (value) => {
          drawn.push(value);
          keptCursor = (value as { readonly cursor: string }).cursor;
        },
        (end) => {
          ends.push(end);
          open();
        },
      );
    };
    open();
    await vi.waitFor(() => {
      expect(helperEnds[0]?.received).toHaveLength(1);
    });
    const opened = helperEnds[0]?.received[0];
    if (opened?.kind !== "stream.open") {
      throw new Error("expected the stream on the first port");
    }
    helperEnds[0]?.answer({
      kind: "stream.value",
      streamId: opened.streamId,
      json: '{"cursor":"c-7"}',
      attachments: [],
    });

    helperEnds[0]?.close();
    expect(ends).toStrictEqual([{ reason: "failed", message: NOT_ANSWERING_MESSAGE }]);
    await vi.waitFor(() => {
      expect(helperEnds[1]?.received).toHaveLength(1);
    });
    expect(helperEnds[1]?.received[0]).toMatchObject({
      kind: "stream.open",
      method: "session.subscribe",
      params: { sessionId: "s", afterCursor: "c-7" },
    });
    expect(drawn).toStrictEqual([{ cursor: "c-7" }]);
  });
});
