// The queue shelf on the rail: three states that must not render alike.
//
// A queue that was read and holds nothing, a queue nobody managed to read, and a
// queue whose live tail delivered a row this build cannot decode. The first hides
// the shelf; the other two must not, because both of them are the console saying
// something about a queue it does not know the contents of.
//
// Every bridge here is the shipped fixture with ONE arm this file decides, through
// the bridge family's own helper: a test outside `bridge/` stands in for a surface,
// and a surface reaches the wire through the call door.

import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { withCapturedStream } from "../../../console/bridge/fixture-bridge.test-support.js";
import { QUEUE_SUBSCRIBE_STREAM } from "../../../console/bridge/index.js";
import { mountRailSettled, railBridgeAnswering } from "./rail.test-support.js";

const QUEUE_LIST_METHOD = "run.queueList";

/**
 * The rail's bridge with the queue snapshot answering `queueListReply`.
 *
 * Only that one call is intercepted. The account registry is the rail's other mount
 * read and stays scripted by the scenario, because a case about the queue over a
 * bridge that answered neither would be reading the registry's refusal instead.
 */
function bridgeAnsweringQueueWith(queueListReply: unknown): ReturnType<typeof railBridgeAnswering> {
  return railBridgeAnswering(async (call, forward) =>
    call.method === QUEUE_LIST_METHOD ? queueListReply : forward(),
  );
}

describe("ComposerAccessoryRail — the queue shelf", () => {
  it("hides the queue shelf once the read says nothing is queued", async () => {
    // The hidden arm is about a queue that WAS read: an empty list nobody could
    // read is the case below, and the two must not render alike.
    const container = await mountRailSettled([], {
      bridge: bridgeAnsweringQueueWith({ items: [] }),
    });

    expect(container.querySelector(".meridian-queue-shelf")).toBeNull();
  });

  it("shows the shelf's refusal when the queue snapshot could not be read", async () => {
    // The finding: the rail handed the shelf rows and neither the phase nor the
    // read's refusal, so a refused snapshot over an empty tail hid the shelf — the
    // composer saying nothing is queued about a queue nobody managed to read.
    const container = await mountRailSettled([], {
      bridge: bridgeAnsweringQueueWith({ queue: [] }),
    });

    const shelf = container.querySelector(".meridian-queue-shelf");
    expect(shelf).not.toBeNull();
    expect(shelf?.querySelector(".meridian-partial-read__copy")?.textContent).toContain(
      "The read of the queue was refused",
    );
    // The read's own refusal, carried rather than paraphrased. `run.queueList` IS a
    // registered method, so the reply above is parsed at the call door and refused
    // there — which is the code the shelf renders.
    expect(shelf?.querySelector(".meridian-refusal")?.textContent).toContain("reply-unreadable");
  });

  it("shows the shelf's partial-read line once a queue delivery could not be read", async () => {
    // The feed counts an unreadable delivery; the rail has to HAND that count to the
    // shelf, or the shelf hides itself over an empty list it does not know is empty.
    // The bridge answers the queue snapshot with no rows and hands the case the queue
    // stream's own handler — the rail opens more than one stream, so capturing by
    // name is what keeps this about the queue.
    const tail = withCapturedStream(
      bridgeAnsweringQueueWith({ items: [] }),
      QUEUE_SUBSCRIBE_STREAM,
    );
    const container = await mountRailSettled([], { bridge: tail.bridge });
    expect(container.querySelector(".meridian-queue-shelf")).toBeNull();

    act(() => {
      tail.deliver({ id: "queue-item-a", status: "waiting", rank: 3 });
    });

    expect(container.querySelector(".meridian-partial-read__copy")?.textContent).toContain(
      "1 delivery could not be read",
    );
  });
});
