// Covers `index.ts`, the composition root: a steer sent through the driver is the newest message
// a later conversation cut names as seen, since Claude Code refuses a cut past a prompt it was not
// told about.

import { describe, expect, it } from "vitest";

import { ClaudeDriver } from "../index.js";
import {
  buildCreateSessionParams,
  buildStartRunParams,
  buildSteerParams,
  TEST_BINDING_ID,
  TEST_SESSION_ID,
} from "../__fixtures__/transport-doubles.js";
import {
  armRunDispatch,
  buildHarness,
  spawnedChannel,
  TEST_MESSAGE_ID,
} from "./lifecycle.test-support.js";

describe("ClaudeDriver", () => {
  it("names the newest message sent, a steer included, on a conversation cut", async () => {
    const harness = buildHarness();
    const driver = new ClaudeDriver({
      ...harness.dependencies,
      readSpawnedVersion: () => Promise.reject(new Error("no build is read here")),
      probe: () => Promise.reject(new Error("no build is probed here")),
    });
    await driver.createSession(buildCreateSessionParams());
    const channel = spawnedChannel(harness);
    armRunDispatch(harness);
    await driver.startRun(buildStartRunParams());
    const steer = buildSteerParams("and the tests");
    await driver.applyIntervention(steer);
    channel.controlResponse = {
      subtype: "success",
      response: { rewound: true, prefillText: "review the diff" },
    };

    const cut = await driver.rewindConversation({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
      targetMessageId: TEST_MESSAGE_ID,
    });

    expect(channel.controlRequests.at(-1)).toStrictEqual({
      subtype: "rewind_conversation",
      target_message_uuid: TEST_MESSAGE_ID,
      last_seen_user_message_uuid: steer.clientIdempotencyKey,
      interrupt_if_running: true,
    });
    expect(cut).toStrictEqual({ status: "applied", cutMessageText: "review the diff" });
  });
});
