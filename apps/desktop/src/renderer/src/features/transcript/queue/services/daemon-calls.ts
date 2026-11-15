// The calls one session's queue reading makes, over the daemon: the list, the live tail, a cancel
// and a retry. A refused call rejects with the daemon's refusal, which the reading and the row's
// control draw; the tail is opened again when it ends, and the window's returning edge reads the
// list again for what the gap hid.

import type { RunQueueStreamFrame } from "@ai-sidekicks/contracts/run/queue";

import { RUN_QUEUE_EVENT_STREAM } from "#shared/daemon/streams.js";
import { callDaemon, unwrapDaemonReply } from "#renderer/services/daemon/reply.js";
import { subscribeDaemon } from "#renderer/services/daemon/streams.js";
import { heldIdAsWireId } from "#renderer/services/daemon/wire/identifiers.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { openReopeningSubscription } from "#renderer/services/transport/reopening-subscription.js";
import type { QueueCalls } from "../reading.js";

/** One session's queue calls through `bridge`. */
export function queueCallsThroughDaemon(bridge: PlatformBridge): QueueCalls {
  return {
    list: async (sessionId) =>
      unwrapDaemonReply(
        await callDaemon(bridge, "agent.queueItem.list", {
          sessionId: heldIdAsWireId(sessionId),
        }),
      ).items,
    tail: (sessionId, onFrame) =>
      openReopeningSubscription({
        signal: bridge.transportReconnect,
        subject: RUN_QUEUE_EVENT_STREAM,
        open: (deliver, onEnded) =>
          subscribeDaemon(
            bridge,
            { method: RUN_QUEUE_EVENT_STREAM, request: { sessionId: heldIdAsWireId(sessionId) } },
            deliver,
            onEnded,
          ),
        // The service's own frame, read as its generated type.
        onFrame: (payload) => {
          onFrame(payload as RunQueueStreamFrame);
        },
      }),
    cancel: async (queueItemId) => {
      unwrapDaemonReply(
        await callDaemon(bridge, "agent.queueItem.cancel", {
          queueItemId: heldIdAsWireId(queueItemId),
        }),
      );
    },
    retry: async (request) => {
      unwrapDaemonReply(await callDaemon(bridge, "agent.queueItem.create", request));
    },
  };
}
