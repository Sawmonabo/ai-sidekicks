// A held note quotes its line as the diff read when it was added, and reads stranded once its line
// is no longer a changed line in the diff its comparison names or no longer says what it quoted,
// in a real repository: the branch against its base, and the uncommitted changes with an untracked
// file counted as new. A resent add answers the note already held and holds one, and a remove
// answers only the notes it discarded.

import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ReviewNoteAddRequest, ReviewNoteId } from "@ai-sidekicks/contracts/review-note";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import {
  openScratchDatabase,
  type ScratchDatabase,
} from "../../../database/__fixtures__/scratch.js";
import { FIXTURE_GIT_TIMEOUT_MS } from "../../../git/__fixtures__/command.js";
import { createGitCommand } from "../../../git/process.js";
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
let store: SessionReviewNoteStore;

beforeEach(async () => {
  repository = await createFixtureRepository();
  scratch = await openScratchDatabase();
  sessionId = mintSessionId();
  await seedSessionRow(scratch.writer, sessionId);
  const runGit = createGitCommand({ git: repository.runner, timeoutMs: FIXTURE_GIT_TIMEOUT_MS });
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
  location: Pick<ReviewNoteAddRequest, "comparison" | "path" | "line">,
): ReviewNoteAddRequest {
  return {
    sessionId,
    noteId: randomUUID() as ReviewNoteId,
    side: "added",
    body: "Start from the saved total",
    ...location,
  };
}

describe("a held note on the branch", () => {
  it("is stranded once its line is rewritten, and at once on an unchanged line", async () => {
    await repository.git(["switch", "-q", "-c", "feature"]);
    await repository.write(
      repository.root,
      "src/app.ts",
      "export const answer: number = 42;\nexport const total: number = 0;\n",
    );
    await repository.git(["commit", "-q", "-am", "add a total"]);
    const comparison = {
      scope: "branch" as const,
      base: "main",
      headCommitId: await repository.git(["rev-parse", "HEAD"]),
    };

    const onAddedLine = await store.add(noteOn({ comparison, path: "src/app.ts", line: 2 }));
    const onUnchangedLine = await store.add(noteOn({ comparison, path: "src/app.ts", line: 1 }));

    expect(onAddedLine.note).toMatchObject({
      quote: "export const total: number = 0;",
      stranded: false,
    });
    expect(onUnchangedLine.note).toMatchObject({ quote: "", stranded: true });

    await repository.write(
      repository.root,
      "src/app.ts",
      "export const answer: number = 42;\nexport const total: number = 1;\n",
    );
    await repository.git(["commit", "-q", "-am", "start the total at one"]);

    const { notes } = await store.list(sessionId);
    expect(notes.find((note) => note.noteId === onAddedLine.note.noteId)).toMatchObject({
      quote: "export const total: number = 0;",
      stranded: true,
    });
  });
});

describe("a held note on the uncommitted changes", () => {
  it("holds on an untracked file's line until the file is committed", async () => {
    await repository.write(repository.root, "src/total.ts", "export const total = 0;\n");
    const comparison = {
      scope: "changes" as const,
      base: "HEAD",
      workingTreeBlobId: await repository.git(["hash-object", "src/total.ts"]),
    };

    const added = await store.add(noteOn({ comparison, path: "src/total.ts", line: 1 }));
    expect(added.note).toMatchObject({ quote: "export const total = 0;", stranded: false });

    await repository.git(["add", "src/total.ts"]);
    await repository.git(["commit", "-q", "-m", "add the total"]);

    expect((await store.list(sessionId)).notes).toStrictEqual([
      expect.objectContaining({ noteId: added.note.noteId, stranded: true }),
    ]);
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
