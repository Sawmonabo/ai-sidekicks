// A closed queue subscription reads nothing from the snapshot it asked for.
//
// THE SAME DEFECT THE ACCOUNT PLANE HAD, on the same shape: `run.queueList` answers
// with the whole of a session's queue at one moment, the open takes that read straight
// and the scheduler takes every later one, and a private ordinal decided which reply
// could SEAT while saying nothing to the call itself. So a pane that unmounted with a
// snapshot on the wire went on waiting for it and parsing every row against the
// registered list shape for a reading that had been closed.
//
// THE READ IS CAUGHT MID-FLIGHT WITHOUT PARKING ANYTHING. `open()` reaches the call
// door in its own synchronous stretch — the round is opened, the request is parsed,
// and the bridge is asked, all before the first `await` yields — so a `close()` on the
// very next line lands while the reply is still outstanding. That is the interleaving
// this file is about, and it needs no held-call machinery to produce.
//
// THE EVIDENCE IS THE PARSE, for the reason the account plane's suite states: a closed
// reading renders nothing, so no reading could distinguish a snapshot that was skipped
// from one that was read and discarded. The spy watches the REGISTERED response schema
// the door itself resolves for this method, and the control drives the same spy over a
// subscription that stayed open.

import { describe, expect, it, vi } from "vitest";

import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import { CONSOLE_DAEMON_METHOD_BINDINGS } from "../daemon/daemon-reply-registry.js";
import { SessionQueueSubscription } from "./queue-subscription.js";
import { queueFeedBridge, REGISTERED_ROW_DELIVERY, SESSION_ID } from "./queue-feed.test-support.js";

/** The parser the door resolves for the snapshot read, named once. */
const LIST_REPLY_SCHEMA = CONSOLE_DAEMON_METHOD_BINDINGS["run.queueList"].responseSchema;

describe("the queue snapshot read — closing the tail ends it", () => {
  it("parses nothing from a snapshot that lands after the reading closed", async () => {
    const { bridge, calls } = queueFeedBridge([REGISTERED_ROW_DELIVERY]);
    const subscription = new SessionQueueSubscription(bridge, SESSION_ID, () => undefined);

    const replyParse = vi.spyOn(LIST_REPLY_SCHEMA, "safeParse");
    try {
      subscription.open();
      // The request is already on the fixture, which is what makes this the mid-flight
      // case: the reply has not landed and the reading is closed under it.
      expect(calls.map((call) => call.method)).toStrictEqual(["run.queueList"]);
      subscription.close();
      await crossMacrotaskBoundary();

      expect(replyParse).not.toHaveBeenCalled();
      expect(subscription.reading.items).toStrictEqual([]);
    } finally {
      replyParse.mockRestore();
    }
  });

  it("negative control: that same spy sees the parse when the reading stays open", async () => {
    // Same bridge, same subscription, same snapshot — the one thing that moved is the
    // close. Without it the zero above would be satisfied by a spy on a schema the
    // door never reaches, or by a fixture that answered nothing.
    const { bridge } = queueFeedBridge([REGISTERED_ROW_DELIVERY]);
    const subscription = new SessionQueueSubscription(bridge, SESSION_ID, () => undefined);

    const replyParse = vi.spyOn(LIST_REPLY_SCHEMA, "safeParse");
    try {
      subscription.open();
      await crossMacrotaskBoundary();

      expect(replyParse).toHaveBeenCalledTimes(1);
      expect(subscription.reading.items).toHaveLength(1);
    } finally {
      replyParse.mockRestore();
      subscription.close();
    }
  });
});
