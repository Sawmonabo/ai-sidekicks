// Covers `index.ts`, the composition root: a steer sent through the driver is the newest message
// a later conversation cut names as seen, since Claude Code refuses a cut past a prompt it was not
// told about; and every staged file reaches Claude Code with its message, at a run's start and on
// a send into the running turn alike.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FakeAttachmentResolver,
  ONE_PIXEL_PNG,
  STAGED_ATTACHMENT_IDS,
  stagedFiles,
} from "../../__fixtures__/attachment-doubles.js";
import { ClaudeDriver } from "../index.js";
import {
  buildCreateSessionParams,
  buildStartRunParams,
  buildSteerParams,
  TEST_BINDING_ID,
  TEST_RUN_ID,
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
      readBuild: () => Promise.reject(new Error("no build is read here")),
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

  describe("staged files", () => {
    let folder: string | undefined;
    afterEach(async () => {
      if (folder !== undefined) {
        await rm(folder, { recursive: true, force: true });
      }
    });

    it("go with the message at a run's start and on a send into its turn, in order", async () => {
      folder = await mkdtemp(path.join(tmpdir(), "claude-attachments-"));
      await writeFile(path.join(folder, "picture"), ONE_PIXEL_PNG);
      const harness = buildHarness({
        attachments: new FakeAttachmentResolver(stagedFiles(folder)),
      });
      const driver = new ClaudeDriver({
        ...harness.dependencies,
        readBuild: () => Promise.reject(new Error("no build is read here")),
      });
      await driver.createSession(buildCreateSessionParams());
      const channel = spawnedChannel(harness);
      const staged = [
        STAGED_ATTACHMENT_IDS.picture,
        STAGED_ATTACHMENT_IDS.deleted,
        STAGED_ATTACHMENT_IDS.textFile,
      ];
      armRunDispatch(harness, TEST_RUN_ID, "what is wrong here", TEST_SESSION_ID, staged);
      await driver.startRun(buildStartRunParams());
      await driver.applyIntervention(buildSteerParams("and here", staged));

      // The picture is an image block of its own bytes, the text file its path in the words, and
      // the deleted file a line in its own place saying why it is missing.
      const filesAfter = (words: string): unknown => [
        { type: "text", text: words },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: ONE_PIXEL_PNG.toString("base64"),
          },
        },
        {
          type: "text",
          text: `Attached file ${STAGED_ATTACHMENT_IDS.deleted} was not delivered: it was deleted.`,
        },
        { type: "text", text: `Attached file notes.txt: ${folder}/notes` },
      ];
      expect(channel.sentUserFrames.map((frame) => frame.message.content)).toStrictEqual([
        filesAfter("what is wrong here"),
        filesAfter("and here"),
      ]);
    });
  });
});
