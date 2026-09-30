// The session stream across the SDK seam: the daemon sends batched frames, and
// the client hands its caller one event at a time with each event's own
// cursor, ending the iteration at a drop mark so the caller resubscribes after
// the last event it saw instead of silently skipping the gap.
import { describe, expect, it } from "vitest";

import type {
  EventCursor,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponseEnvelope,
  SessionEvent,
  SessionId,
} from "@ai-sidekicks/contracts";
import { JSONRPC_VERSION, SUBSCRIPTION_NOTIFY_METHOD } from "@ai-sidekicks/contracts";

import { SessionStreamDroppedError, createDaemonSessionClient } from "../session-client.js";
import { JsonRpcClient } from "../transport/json-rpc-client.js";
import type { ClientTransport } from "../transport/types.js";

type InboundEnvelope = JsonRpcResponseEnvelope | JsonRpcNotification;

/** Low-entropy sentinel ids, so the secret scanner has nothing to flag. */
const SUBSCRIPTION_ID = "00000000-0000-4000-8000-000000000011";
const SESSION_ID = "00000000-0000-4000-8000-000000000012" as SessionId;

function sessionCreated(sequence: number): SessionEvent {
  return {
    id: `evt-${String(sequence)}`,
    sessionId: SESSION_ID,
    sequence,
    occurredAt: "2026-01-22T19:14:35.000Z",
    category: "session_lifecycle",
    type: "session.created",
    actor: null,
    version: "1.0" as SessionEvent["version"],
    payload: { sessionId: SESSION_ID, config: {}, metadata: {} },
  };
}

/** A daemon that acks `session.subscribe` and then pushes the frames a test hands it. */
function subscribingDaemon(): {
  readonly transport: ClientTransport;
  readonly push: (value: unknown) => void;
} {
  let inbound: (message: InboundEnvelope) => void = () => undefined;
  return {
    transport: {
      send(envelope): void {
        if ("id" in envelope) {
          const request = envelope as JsonRpcRequest;
          inbound({
            jsonrpc: JSONRPC_VERSION,
            id: request.id,
            result: { subscriptionId: SUBSCRIPTION_ID },
          });
        }
      },
      onMessage(handler): void {
        inbound = handler;
      },
      onClose(): void {},
      close: () => Promise.resolve(),
    },
    push(value): void {
      inbound({
        jsonrpc: JSONRPC_VERSION,
        method: SUBSCRIPTION_NOTIFY_METHOD,
        params: { subscriptionId: SUBSCRIPTION_ID, value },
      });
    },
  };
}

describe("session subscribe reads the daemon's frames", () => {
  it("yields each change with its own cursor, then ends at a drop mark naming the last cursor seen", async () => {
    const daemon = subscribingDaemon();
    const client = createDaemonSessionClient(
      new JsonRpcClient(daemon.transport, { protocolVersion: "2026-05-01" }),
    );
    const stream = client.subscribe({ sessionId: SESSION_ID })[Symbol.asyncIterator]();
    // The generator sends `session.subscribe` on its first pull, so the frames
    // are pushed only once that pull is pending and the ack has settled.
    const first = stream.next();
    await Promise.resolve();

    daemon.push({
      changes: [
        { cursor: "c-1", event: sessionCreated(1) },
        { cursor: "c-2", event: sessionCreated(2) },
      ],
    });
    daemon.push({ changes: [{ cursor: "c-9", event: sessionCreated(9) }], dropped: true });

    expect((await first).value).toStrictEqual({
      eventId: "c-1" as EventCursor,
      event: sessionCreated(1),
    });
    expect((await stream.next()).value).toStrictEqual({
      eventId: "c-2" as EventCursor,
      event: sessionCreated(2),
    });
    const ended = stream.next();
    await expect(ended).rejects.toBeInstanceOf(SessionStreamDroppedError);
    await expect(ended).rejects.toMatchObject({ lastCursor: "c-2" });
  });
});
