// The session stream across the SDK seam: the daemon sends batched frames, and
// the client hands its caller one event at a time with each event's own
// cursor, ending the iteration at a drop mark so the caller resubscribes after
// the last event it saw instead of silently skipping the gap.
import { describe, expect, it } from "vitest";

import type { EventCursor, SessionId } from "@ai-sidekicks/contracts/session/session";
import type { SessionEvent } from "@ai-sidekicks/contracts/event/variant-types";
import { SUBSCRIPTION_CANCEL_METHOD } from "@ai-sidekicks/contracts/jsonrpc/streaming";

import { SessionStreamDroppedError, createDaemonSessionClient } from "../session-client.js";
import { JsonRpcClient } from "../transport/json-rpc-client.js";
import {
  answerByMethod,
  buildSessionCreatedEvent,
  buildSubscriptionNotify,
  createScriptedDaemon,
  TEST_CLIENT_OPTIONS,
} from "./scripted-daemon.test-support.js";

/** Low-entropy sentinel ids, so the secret scanner has nothing to flag. */
const SUBSCRIPTION_ID = "00000000-0000-4000-8000-000000000011";
const SESSION_ID = "00000000-0000-4000-8000-000000000012" as SessionId;

function sessionCreated(sequence: number): SessionEvent {
  return buildSessionCreatedEvent({
    id: `evt-${String(sequence)}`,
    sessionId: SESSION_ID,
    sequence,
  });
}

describe("session subscribe reads the daemon's frames", () => {
  it(
    "yields each change with its own cursor, then " +
      "ends at a drop mark naming the last cursor seen",
    async () => {
      // A daemon that acks `session.subscribe` and the cancel; the frames are pushed by hand below.
      const daemon = createScriptedDaemon(
        answerByMethod({
          "session.subscribe": () => ({ result: { subscriptionId: SUBSCRIPTION_ID } }),
          [SUBSCRIPTION_CANCEL_METHOD]: () => ({ result: { canceled: true } }),
        }),
      );
      const client = createDaemonSessionClient(new JsonRpcClient(daemon, TEST_CLIENT_OPTIONS));
      const stream = client.subscribe({ sessionId: SESSION_ID })[Symbol.asyncIterator]();
      // The generator sends `session.subscribe` on its first pull, so the frames
      // are pushed only once that pull is pending and the ack has settled.
      const first = stream.next();
      await Promise.resolve();

      daemon.deliverInbound(
        buildSubscriptionNotify(SUBSCRIPTION_ID, {
          changes: [
            { cursor: "c-1", event: sessionCreated(1) },
            { cursor: "c-2", event: sessionCreated(2) },
          ],
        }),
      );
      daemon.deliverInbound(
        buildSubscriptionNotify(SUBSCRIPTION_ID, {
          changes: [{ cursor: "c-9", event: sessionCreated(9) }],
          dropped: true,
        }),
      );

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
    },
  );
});
