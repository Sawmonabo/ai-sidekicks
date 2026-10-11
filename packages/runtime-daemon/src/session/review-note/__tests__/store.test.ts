// A held note quotes its line from that side's file at its comparison, context lines included,
// and reads stranded once that line is gone or no longer says what it quoted, in a real
// repository: the branch against its base, a pull request at its head commit, and the uncommitted
// changes, an unborn `HEAD` among them. A file deleted, ignored or outside the folder reads as
// having no lines without ending the list. A resent add answers the note already held, an update
// refuses a note the session does not hold, a remove answers only the notes it discarded, and a
// follower gets one read in flight and one after a burst of changes.

import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  ReviewNoteAddRequest,
  ReviewNoteId,
  ReviewNoteSet,
} from "@ai-sidekicks/contracts/review-note";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import {
  openScratchDatabase,
  type ScratchDatabase,
} from "../../../database/__fixtures__/scratch.js";
import { FIXTURE_GIT_TIMEOUT_MS } from "../../../git/__fixtures__/command.js";
import { createGitCommand, type GitCommand } from "../../../git/process.js";
import {
  createFixtureRepository,
  type FixtureRepository,
} from "../../../git/worktree/__fixtures__/repository.js";
import { mintSessionId, seedSessionRow } from "../../directory/__fixtures__/directory-rows.js";
import { NotedLineReader } from "../diff-line.js";
import { SessionReviewNoteStore } from "../store.js";

let repository: FixtureRepository;
let scratch: ScratchDatabase;
let sessionId: SessionId;
let runGit: GitCommand;
let store: SessionReviewNoteStore;

beforeEach(async () => {
  repository = await createFixtureRepository();
  scratch = await openScratchDatabase();
  sessionId = mintSessionId();
  await seedSessionRow(scratch.writer, sessionId);
  runGit = createGitCommand({ git: repository.runner, timeoutMs: FIXTURE_GIT_TIMEOUT_MS });
  store = new SessionReviewNoteStore({
    database: scratch,
    openLineReader: () => Promise.resolve(new NotedLineReader(runGit, repository.root)),
    followWorkingFolder: () => Promise.resolve(() => {}),
  });
});

afterEach(async () => {
  await scratch.close();
  repository.remove();
});

function noteOn(
  location: Pick<ReviewNoteAddRequest, "comparison" | "path" | "line"> &
    Partial<Pick<ReviewNoteAddRequest, "side">>,
): ReviewNoteAddRequest {
  return {
    sessionId,
    noteId: randomUUID() as ReviewNoteId,
    side: "added",
    body: "Start from the saved total",
    ...location,
  };
}

// Commits `src/app.ts` on a new `feature` branch with a second line, answering the commit's id.
async function commitTotalOnFeature(): Promise<string> {
  await repository.git(["switch", "-q", "-c", "feature"]);
  await repository.write(
    repository.root,
    "src/app.ts",
    "export const answer: number = 42;\nexport const total: number = 0;\n",
  );
  await repository.git(["commit", "-q", "-am", "add a total"]);
  return repository.git(["rev-parse", "HEAD"]);
}

// Rewrites the total `commitTotalOnFeature` added and commits it.
async function commitRewrittenTotal(): Promise<void> {
  await repository.write(
    repository.root,
    "src/app.ts",
    "export const answer: number = 42;\nexport const total: number = 1;\n",
  );
  await repository.git(["commit", "-q", "-am", "start the total at one"]);
}

async function changesComparison(filePath: string) {
  return {
    scope: "changes" as const,
    base: "HEAD",
    workingTreeBlobId: await repository.git(["hash-object", filePath]),
  };
}

describe("a held note on the branch", () => {
  it("quotes a changed or unchanged line, and is stranded once its line is rewritten", async () => {
    const comparison = {
      scope: "branch" as const,
      base: "main",
      headCommitId: await commitTotalOnFeature(),
    };

    const onAddedLine = await store.add(noteOn({ comparison, path: "src/app.ts", line: 2 }));
    const onContextLine = await store.add(noteOn({ comparison, path: "src/app.ts", line: 1 }));
    const pastTheEnd = await store.add(noteOn({ comparison, path: "src/app.ts", line: 3 }));

    expect(onAddedLine.note).toMatchObject({
      quote: "export const total: number = 0;",
      stranded: false,
    });
    expect(onContextLine.note).toMatchObject({
      quote: "export const answer: number = 42;",
      stranded: false,
    });
    expect(pastTheEnd.note).toMatchObject({ quote: "", stranded: true });

    await commitRewrittenTotal();

    expect((await store.list(sessionId)).notes).toStrictEqual([
      expect.objectContaining({ noteId: onAddedLine.note.noteId, stranded: true }),
      expect.objectContaining({ noteId: onContextLine.note.noteId, stranded: false }),
      expect.objectContaining({ noteId: pastTheEnd.note.noteId, stranded: true }),
    ]);
  });
});

describe("a held note on a pull request", () => {
  it("reads its line at the request's head commit, stranded once it is unknown", async () => {
    const comparison = {
      scope: "change_request" as const,
      base: "main",
      headCommitId: await commitTotalOnFeature(),
      requestNumber: 7,
    };
    const onAddedLine = await store.add(noteOn({ comparison, path: "src/app.ts", line: 2 }));
    const onRemovedSide = await store.add(
      noteOn({ comparison, path: "src/app.ts", line: 1, side: "removed" }),
    );
    const unknownHead = await store.add(
      noteOn({
        comparison: { ...comparison, headCommitId: "0".repeat(40) },
        path: "src/app.ts",
        line: 2,
      }),
    );

    // The branch moves on past the request's head commit.
    await commitRewrittenTotal();

    expect((await store.list(sessionId)).notes).toStrictEqual([
      expect.objectContaining({
        noteId: onAddedLine.note.noteId,
        quote: "export const total: number = 0;",
        stranded: false,
      }),
      expect.objectContaining({
        noteId: onRemovedSide.note.noteId,
        quote: "export const answer: number = 42;",
        stranded: false,
      }),
      expect.objectContaining({ noteId: unknownHead.note.noteId, quote: "", stranded: true }),
    ]);
  });
});

describe("a held note on the uncommitted changes", () => {
  it("holds on an untracked file's line after the file is committed", async () => {
    await repository.write(repository.root, "src/total.ts", "export const total = 0;\n");
    const comparison = await changesComparison("src/total.ts");

    const added = await store.add(noteOn({ comparison, path: "src/total.ts", line: 1 }));
    expect(added.note).toMatchObject({ quote: "export const total = 0;", stranded: false });

    await repository.git(["add", "src/total.ts"]);
    await repository.git(["commit", "-q", "-m", "add the total"]);

    expect((await store.list(sessionId)).notes).toStrictEqual([
      expect.objectContaining({ noteId: added.note.noteId, stranded: false }),
    ]);
  });

  it("reads a deleted, ignored or outside file as lineless, without ending the list", async () => {
    await repository.write(repository.root, "src/gone.ts", "export const gone = 1;\n");
    // Staged, so git still lists it once it is deleted from the working tree.
    await repository.git(["add", "src/gone.ts"]);
    await repository.write(repository.root, ".env", "TOKEN=secret\n");
    await repository.write(repository.fixtureRoot, "outside.txt", "secret\n");
    const comparison = await changesComparison("src/gone.ts");

    const deleted = await store.add(noteOn({ comparison, path: "src/gone.ts", line: 1 }));
    const ignored = await store.add(noteOn({ comparison, path: ".env", line: 1 }));
    const outside = await store.add(noteOn({ comparison, path: "../outside.txt", line: 1 }));
    const tracked = await store.add(noteOn({ comparison, path: "src/app.ts", line: 1 }));
    expect(deleted.note).toMatchObject({ quote: "export const gone = 1;", stranded: false });
    expect(ignored.note).toMatchObject({ quote: "", stranded: true });
    expect(outside.note).toMatchObject({ quote: "", stranded: true });

    await rm(path.join(repository.root, "src/gone.ts"));

    expect((await store.list(sessionId)).notes).toStrictEqual([
      expect.objectContaining({ noteId: deleted.note.noteId, stranded: true }),
      expect.objectContaining({ noteId: ignored.note.noteId, stranded: true }),
      expect.objectContaining({ noteId: outside.note.noteId, stranded: true }),
      expect.objectContaining({
        noteId: tracked.note.noteId,
        quote: "export const answer: number = 42;",
        stranded: false,
      }),
    ]);
  });

  it("compares a repository with no commit yet against the empty tree", async () => {
    await repository.git(["switch", "-q", "--orphan", "fresh"]);
    await repository.write(repository.root, "src/total.ts", "export const total = 0;\n");
    const comparison = await changesComparison("src/total.ts");

    const onAddedSide = await store.add(noteOn({ comparison, path: "src/total.ts", line: 1 }));
    const onRemovedSide = await store.add(
      noteOn({ comparison, path: "src/total.ts", line: 1, side: "removed" }),
    );

    expect(onAddedSide.note).toMatchObject({ quote: "export const total = 0;", stranded: false });
    expect(onRemovedSide.note).toMatchObject({ quote: "", stranded: true });
  });
});

describe("a resent add", () => {
  it("answers the note already held and holds one note", async () => {
    const comparison = {
      scope: "branch" as const,
      base: "main",
      headCommitId: await repository.git(["rev-parse", "HEAD"]),
    };
    const request = noteOn({ comparison, path: "src/app.ts", line: 1 });

    const first = await store.add(request);
    const resent = await store.add({ ...request, body: "A second wording" });

    expect(resent.note).toStrictEqual(first.note);
    expect((await store.list(sessionId)).notes).toStrictEqual([first.note]);
  });
});

describe("an update", () => {
  it("replaces a held note's words, and refuses a note the session does not hold", async () => {
    const comparison = await changesComparison("src/app.ts");
    const { note } = await store.add(noteOn({ comparison, path: "src/app.ts", line: 1 }));

    const updated = await store.update({ sessionId, noteId: note.noteId, body: "Keep the total" });

    expect(updated.note).toMatchObject({ noteId: note.noteId, body: "Keep the total" });
    expect((await store.list(sessionId)).notes).toStrictEqual([updated.note]);
    const unknownNoteId = randomUUID() as ReviewNoteId;
    await expect(
      store.update({ sessionId, noteId: unknownNoteId, body: "Keep the total" }),
    ).rejects.toMatchObject({
      code: "session.review_note_not_found",
      detail: { noteId: unknownNoteId },
    });
  });
});

describe("a remove", () => {
  it("answers only the notes it discarded, so a resent remove answers none", async () => {
    const comparison = {
      scope: "branch" as const,
      base: "main",
      headCommitId: await repository.git(["rev-parse", "HEAD"]),
    };
    const { note } = await store.add(noteOn({ comparison, path: "src/app.ts", line: 1 }));
    const request = { sessionId, noteIds: [note.noteId, randomUUID() as ReviewNoteId] };

    expect(await store.remove(request)).toStrictEqual({ removedNoteIds: [note.noteId] });
    expect(await store.remove(request)).toStrictEqual({ removedNoteIds: [] });
    expect((await store.list(sessionId)).notes).toStrictEqual([]);
  });
});

describe("a follower", () => {
  it("reads once more after a burst of changes and sends only the newest set", async () => {
    const comparison = await changesComparison("src/app.ts");
    const { note } = await store.add(noteOn({ comparison, path: "src/app.ts", line: 1 }));
    const firstReadHeld = Promise.withResolvers<void>();
    let reads = 0;
    let changeFolder = (): void => {};
    const followedStore = new SessionReviewNoteStore({
      database: scratch,
      openLineReader: async () => {
        reads += 1;
        if (reads === 1) {
          await firstReadHeld.promise;
        }
        return new NotedLineReader(runGit, repository.root);
      },
      followWorkingFolder: (_followedSessionId, onChange) => {
        changeFolder = onChange;
        return Promise.resolve(() => {});
      },
    });
    const sent: ReviewNoteSet[] = [];
    const firstSend = Promise.withResolvers<void>();

    const detach = await followedStore.follow(sessionId, {
      send: (notes) => {
        sent.push(notes);
        firstSend.resolve();
      },
      fail: firstSend.reject,
    });
    // The words change and the folder changes three times while the first read is held.
    await store.update({ sessionId, noteId: note.noteId, body: "Keep the total" });
    changeFolder();
    changeFolder();
    changeFolder();
    firstReadHeld.resolve();
    await firstSend.promise;
    detach();

    expect(reads).toBe(2);
    expect(sent).toStrictEqual([
      { notes: [expect.objectContaining({ noteId: note.noteId, body: "Keep the total" })] },
    ]);
  });
});
