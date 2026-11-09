// A staged file goes out under main's token, and the staged set the daemon answers becomes the
// held draft's files; a file the daemon would not stage is named with its cause, a failed copy can
// be copied again, and a send waits for a copy still running.

import { describe, expect, it } from "vitest";

import type { ArtifactId } from "@ai-sidekicks/contracts/artifacts/id";
import type {
  SessionAttachmentAddResponse,
  SessionAttachmentSummary,
} from "@ai-sidekicks/contracts/session/draft";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { DaemonReply } from "#renderer/services/daemon/reply.js";
import { MAXIMUM_LIVE_DRAFT_COUNT } from "#renderer/store/persistence/caps.js";
import { DraftStore } from "#renderer/store/drafts.js";
import type { FilePathRef } from "#shared/preload-api.js";
import { composerDraftKey } from "../draft-line/draft-key.js";
import { ComposerHeldDraft } from "../held-draft/holder.js";
import { ComposerStaging, type StagingItem } from "./staging.js";

const SESSION_ID = "8f1c2c3e-5c6a-4a19-9f5f-1d2b3c4d5e6f" as SessionId;
const NOTES: SessionAttachmentSummary = {
  artifactId: "6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d" as ArtifactId,
  fileName: "notes.md",
  mimeType: "text/markdown",
  sizeBytes: 2048,
};

/** Staging over a stage call the test answers by hand, and the items each call carried. */
function stagingWithHandAnsweredAdd(): {
  readonly staging: ComposerStaging;
  readonly heldDraft: ComposerHeldDraft;
  readonly sent: (readonly StagingItem[])[];
  readonly answer: (reply: DaemonReply<SessionAttachmentAddResponse>) => void;
} {
  const heldDraft = new ComposerHeldDraft({
    draftStore: new DraftStore({ maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT }),
    draftKey: composerDraftKey(SESSION_ID),
  });
  const sent: (readonly StagingItem[])[] = [];
  const answers: ((reply: DaemonReply<SessionAttachmentAddResponse>) => void)[] = [];
  let stagingCount = 0;
  const staging = new ComposerStaging(
    {
      add: async (items) => {
        sent.push(items);
        return await new Promise((resolve) => {
          answers.push(resolve);
        });
      },
      remove: async () => await Promise.reject(new Error("no removal in this suite")),
    },
    heldDraft,
    () => {
      stagingCount += 1;
      return `0b1c2d3e-4f50-4617-8829-3a4b5c6d7e8${String(stagingCount)}`;
    },
  );
  return {
    staging,
    heldDraft,
    sent,
    answer: (reply) => {
      answers.shift()?.(reply);
    },
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("the composer's file staging", () => {
  it("holds a send until the copy lands, then the staged set is the held draft's files", async () => {
    // Mutation: dropping `trackCopy` lets `whenCopied` settle before the file is staged, and a
    // send reads a draft with no file.
    const { staging, heldDraft, sent, answer } = stagingWithHandAnsweredAdd();
    staging.stage([{ ref: "token-notes" as FilePathRef, name: "notes.md" }]);
    expect(sent).toStrictEqual([
      [{ clientStagingId: "0b1c2d3e-4f50-4617-8829-3a4b5c6d7e81", path: "token-notes" }],
    ]);
    expect(staging.snapshot().pending.map((each) => each.name)).toStrictEqual(["notes.md"]);

    let isCopied = false;
    void heldDraft.whenCopied().then(() => {
      isCopied = true;
    });
    await settle();
    expect(isCopied).toBe(false);

    answer({
      status: "served",
      value: { sessionId: SESSION_ID, attachments: [NOTES], refused: [] },
    });
    await settle();
    expect(isCopied).toBe(true);
    expect(heldDraft.snapshot().files).toStrictEqual([NOTES]);
    expect(heldDraft.snapshot().extras.attachments).toStrictEqual([NOTES.artifactId]);
    expect(staging.snapshot().pending).toStrictEqual([]);
  });

  it("names a refused file with the daemon's cause and copies a failed one again", async () => {
    const { staging, sent, answer } = stagingWithHandAnsweredAdd();
    staging.stage([
      { ref: "token-shot" as FilePathRef, name: "shot.png" },
      { ref: "token-big" as FilePathRef, name: "big.iso" },
    ]);
    answer({
      status: "served",
      value: {
        sessionId: SESSION_ID,
        attachments: [],
        refused: [
          {
            clientStagingId: "0b1c2d3e-4f50-4617-8829-3a4b5c6d7e81",
            name: "shot.png",
            cause: {
              code: "session.attachment.refused",
              reason: "copyFailed",
              detail: "disk read failed",
            },
          },
          {
            clientStagingId: "0b1c2d3e-4f50-4617-8829-3a4b5c6d7e82",
            name: "big.iso",
            cause: { code: "session.attachment.refused", reason: "cardWaiting" },
          },
        ],
      },
    });
    await settle();
    const refusals = staging.snapshot().refusals;
    expect(refusals.map((each) => `${each.name} was not attached · ${each.cause}`)).toStrictEqual([
      "shot.png was not attached · disk read failed",
      "big.iso was not attached · Card waiting",
    ]);
    expect(refusals[1]?.retry).toBeUndefined();

    staging.retry("0b1c2d3e-4f50-4617-8829-3a4b5c6d7e81");
    expect(sent[1]).toStrictEqual([
      { clientStagingId: "0b1c2d3e-4f50-4617-8829-3a4b5c6d7e83", path: "token-shot" },
    ]);
  });
});
