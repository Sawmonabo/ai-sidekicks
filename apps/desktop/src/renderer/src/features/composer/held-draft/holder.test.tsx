// A draft the daemon holds, a message a Stop put back or one saved on another device, lands whole:
// its words in the line, its staged files in the strip, its skill picks kept for the send. A draft
// this composer already took, or the empty draft of revision 0, never writes over typed words.
// Typing is saved to the daemon once a pause ends and at once when the session is left, and a
// save refused as stale merges the newer draft and saves again over it.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ArtifactId } from "@ai-sidekicks/contracts/artifacts/id";
import {
  SESSION_DRAFT_REVISION_STALE_CODE,
  type SessionDraft,
  type SessionDraftUpdateResponse,
} from "@ai-sidekicks/contracts/session/draft";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { ManualClock } from "#renderer/lib/clock.js";
import type { DaemonReply } from "#renderer/services/daemon/reply.js";
import { MAXIMUM_LIVE_DRAFT_COUNT } from "#renderer/store/persistence/caps.js";
import { DraftStore } from "#renderer/store/drafts.js";
import { HeldAttachmentStrip } from "../attachments/HeldAttachmentStrip.js";
import { COMPOSER_DRAFT_SAVE_PAUSE_MILLISECONDS } from "../bounds.js";
import { composerDraftKey } from "../draft-line/draft-key.js";
import { ComposerHeldDraft } from "./holder.js";

const SESSION_ID = "8f1c2c3e-5c6a-4a19-9f5f-1d2b3c4d5e6f" as SessionId;
const DRAFT_KEY = composerDraftKey(SESSION_ID);
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
  return new ComposerHeldDraft({ draftStore, draftKey: DRAFT_KEY });
}

/** One save the holder asked for, answered when the case says. */
interface PendingSave {
  readonly draft: SessionDraft;
  readonly expectedRevision: number;
  answer(reply: DaemonReply<SessionDraftUpdateResponse>): void;
}

/** A holder that saves through a recorder on a manual clock, started as a mounted composer is. */
function savingHolder(): {
  readonly draftStore: DraftStore;
  readonly heldDraft: ComposerHeldDraft;
  readonly clock: ManualClock;
  readonly saves: PendingSave[];
} {
  const draftStore = new DraftStore({ maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT });
  const clock = new ManualClock();
  const saves: PendingSave[] = [];
  const heldDraft = new ComposerHeldDraft({
    draftStore,
    draftKey: DRAFT_KEY,
    saving: {
      clock,
      save: async (draft, expectedRevision) =>
        await new Promise((answer) => {
          saves.push({ draft, expectedRevision, answer });
        }),
    },
  });
  heldDraft.start();
  return { draftStore, heldDraft, clock, saves };
}

/** The daemon's answer to a save that landed at `revision`. */
function savedAt(revision: number): DaemonReply<SessionDraftUpdateResponse> {
  return {
    status: "served",
    value: { sessionId: SESSION_ID, revision, updatedAt: "2026-11-09T10:00:00.000Z" },
  };
}

/** Let a settled save's reply reach the holder. */
async function settleReplies(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
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

describe("ComposerHeldDraft — saving the draft to the daemon", () => {
  it("saves once after typing pauses, and at once when the session is left", async () => {
    // Mutation: saving on every keystroke records three saves; dropping the restart of the pause
    // saves before the last word; dropping the save in `stop` leaves the last words unsaved.
    const { draftStore, heldDraft, clock, saves } = savingHolder();

    draftStore.write(DRAFT_KEY, "Fix");
    clock.advance(COMPOSER_DRAFT_SAVE_PAUSE_MILLISECONDS - 1);
    draftStore.write(DRAFT_KEY, "Fix the");
    clock.advance(COMPOSER_DRAFT_SAVE_PAUSE_MILLISECONDS - 1);
    draftStore.write(DRAFT_KEY, "Fix the parser");
    expect(saves).toHaveLength(0);
    clock.advance(COMPOSER_DRAFT_SAVE_PAUSE_MILLISECONDS);

    expect(saves.map(({ draft, expectedRevision }) => ({ draft, expectedRevision }))).toStrictEqual(
      [{ draft: { text: "Fix the parser", extras: {} }, expectedRevision: 0 }],
    );
    saves[0]?.answer(savedAt(1));
    await settleReplies();

    draftStore.write(DRAFT_KEY, "Fix the parser today");
    heldDraft.stop();

    expect(saves.map(({ draft, expectedRevision }) => ({ draft, expectedRevision }))).toStrictEqual(
      [
        { draft: { text: "Fix the parser", extras: {} }, expectedRevision: 0 },
        { draft: { text: "Fix the parser today", extras: {} }, expectedRevision: 1 },
      ],
    );
    expect(clock.pendingCount).toBe(0);
  });

  it("merges the newer draft a stale save missed and saves again over it", async () => {
    // Mutation: dropping the save-again on a stale refusal leaves the merge unsaved; dropping the
    // merge in `take` writes the other device's words over what was typed here.
    const { draftStore, heldDraft, saves } = savingHolder();
    heldDraft.take({
      kind: "held",
      held: { draft: { text: "Fix the parser", extras: {} }, revision: 1 },
      files: [],
    });
    draftStore.write(DRAFT_KEY, "Fix the parser and the lexer");
    heldDraft.saveNow();

    // Another device saved first: its draft arrives on the stream, then this save is refused.
    heldDraft.take({
      kind: "held",
      held: { draft: { text: "Also bump the version", extras: {} }, revision: 2 },
      files: [],
    });
    saves[0]?.answer({
      status: "refused",
      refusal: {
        code: SESSION_DRAFT_REVISION_STALE_CODE,
        detail: "A newer draft is held.",
        origin: "daemon",
      },
    });
    await settleReplies();

    const merged = "Also bump the version\n\nFix the parser and the lexer";
    expect(draftStore.read(DRAFT_KEY)?.text).toBe(merged);
    expect(saves.map(({ draft, expectedRevision }) => ({ draft, expectedRevision }))).toStrictEqual(
      [
        { draft: { text: "Fix the parser and the lexer", extras: {} }, expectedRevision: 1 },
        { draft: { text: merged, extras: {} }, expectedRevision: 2 },
      ],
    );
    expect(heldDraft.snapshot().saveRefusal).toBeUndefined();
  });
});
