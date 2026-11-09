// A draft the daemon holds, a message a Stop put back or one saved on another device, lands whole:
// its words in the line, its staged files in the strip, its skill picks kept for the send. A draft
// this composer already took, or the empty draft of revision 0, never writes over typed words.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ArtifactId } from "@ai-sidekicks/contracts/artifacts/id";
import type { SessionDraft } from "@ai-sidekicks/contracts/session/draft";

import { MAXIMUM_LIVE_DRAFT_COUNT } from "#renderer/store/persistence/caps.js";
import { DraftStore } from "#renderer/store/drafts.js";
import { HeldAttachmentStrip } from "./attachments/HeldAttachmentStrip.js";
import { composerDraftKey } from "./draft-line/draft-key.js";
import { ComposerHeldDraft } from "./held-draft.js";

const DRAFT_KEY = composerDraftKey("8f1c2c3e-5c6a-4a19-9f5f-1d2b3c4d5e6f");
const ARTIFACT_ID = "6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d" as ArtifactId;
const PICK = { name: "codemod", folderPath: "/repo/.ai-sidekicks/skills/codemod" };

/** The message a Stop put back: its words, one staged file and one skill pick. */
const RETURNED: SessionDraft = {
  text: "Run /codemod over the webhook tree",
  extras: { attachments: [ARTIFACT_ID], skills: [PICK] },
};

const QUEUE_FILE = {
  artifactId: ARTIFACT_ID,
  fileName: "queue.ts",
  mimeType: "text/x-typescript",
  sizeBytes: 2048,
};

function heldDraftOver(draftStore: DraftStore): ComposerHeldDraft {
  return new ComposerHeldDraft(draftStore, DRAFT_KEY);
}

describe("ComposerHeldDraft — a returned draft shows whole", () => {
  it("shows the returned draft's file and keeps its skill pick with its words", () => {
    // Mutation: dropping the files or the extras from what `take` publishes empties the strip or
    // loses the pick the send carries.
    const draftStore = new DraftStore({ maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT });
    const heldDraft = heldDraftOver(draftStore);

    heldDraft.take({ kind: "held", held: { draft: RETURNED, revision: 4 }, files: [QUEUE_FILE] });
    render(<HeldAttachmentStrip files={heldDraft.snapshot().files} />);

    expect(draftStore.read(DRAFT_KEY)?.text).toBe("Run /codemod over the webhook tree");
    expect(screen.getByRole("listitem", { name: "Attachment queue.ts" })).toBeTruthy();
    expect(heldDraft.snapshot().extras.skills).toStrictEqual([PICK]);
  });

  it("writes nothing over typed words for the empty draft of revision 0", () => {
    // Mutation: dropping the revision check clears the typed words on the empty revision-0 draft.
    const draftStore = new DraftStore({ maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT });
    const heldDraft = heldDraftOver(draftStore);
    draftStore.write(DRAFT_KEY, "half a thought");

    heldDraft.take({
      kind: "held",
      held: { draft: { text: "", extras: {} }, revision: 0 },
      files: [],
    });

    expect(draftStore.read(DRAFT_KEY)?.text).toBe("half a thought");
  });
});
