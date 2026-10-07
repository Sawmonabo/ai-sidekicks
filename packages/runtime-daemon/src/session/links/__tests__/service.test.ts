// A link an event recorded stays through renames and refuses removal; a `related` link the person
// added unlinks from either side. Each write runs through the real writer on a real database.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import { SESSION_LINK_NOT_REMOVABLE_CODE } from "@ai-sidekicks/contracts/session/links";

import {
  openScratchDatabase,
  type ScratchDatabase,
} from "../../../database/__fixtures__/scratch.js";
import { mintSessionId, seedSessionRow } from "../../groups/__fixtures__/directory-rows.js";
import { SessionRelatedRanking } from "../../related/ranking.js";
import { recordedSessionLinkStatement } from "../recorded.js";
import { SessionLinkService } from "../service.js";

let scratch: ScratchDatabase;
let ranking: SessionRelatedRanking;
let links: SessionLinkService;
let original: SessionId;
let copy: SessionId;
let neighbor: SessionId;

beforeEach(async () => {
  scratch = await openScratchDatabase();
  ranking = new SessionRelatedRanking({
    reader: scratch.reader,
    writer: scratch.writer,
    events: { followAll: () => () => undefined },
    writeServiceLog: (line) => {
      throw new Error(`unexpected service log line: ${line}`);
    },
  });
  links = new SessionLinkService({
    reader: scratch.reader,
    writer: scratch.writer,
    relatedRanking: ranking,
  });
  [original, copy, neighbor] = [mintSessionId(), mintSessionId(), mintSessionId()];
  for (const sessionId of [original, copy, neighbor]) {
    await seedSessionRow(scratch.writer, sessionId);
  }
});

afterEach(async () => {
  await ranking.whenIdle();
  await scratch.close();
});

function storedKinds(): string[] {
  return (
    scratch.reader.prepare("SELECT kind FROM session_links ORDER BY kind").all() as {
      kind: string;
    }[]
  ).map((row) => row.kind);
}

async function rename(sessionId: SessionId, name: string): Promise<void> {
  await scratch.writer.write([
    { sql: "UPDATE sessions SET name = ? WHERE id = ?", bindings: [name, sessionId] },
  ]);
}

describe("a link", () => {
  it("recorded from a fork survives renaming both sessions and refuses removal", async () => {
    await scratch.writer.write([
      recordedSessionLinkStatement({
        sourceSessionId: copy,
        targetSessionId: original,
        kind: "copied_from",
        occurredAt: new Date().toISOString(),
      }),
    ]);
    ranking.rescoreAround([copy, original]);
    await rename(original, "builder");
    await rename(copy, "builder copy");

    for (const [sessionId, targetSessionId] of [
      [copy, original],
      [original, copy],
    ] as const) {
      await expect(links.remove({ sessionId, targetSessionId })).rejects.toMatchObject({
        code: SESSION_LINK_NOT_REMOVABLE_CODE,
      });
    }
    expect(storedKinds()).toEqual(["copied_from"]);

    await ranking.whenIdle();
    expect(ranking.read(copy).related).toEqual([
      {
        sessionId: original,
        name: "builder",
        kind: "copied_from",
        sessionIsSource: true,
        removable: false,
      },
    ]);
  });

  it("added as related is held once per pair and unlinks from the other side", async () => {
    await links.add({ sessionId: original, targetSessionId: neighbor });
    await links.add({ sessionId: neighbor, targetSessionId: original });
    expect(storedKinds()).toEqual(["related"]);
    await ranking.whenIdle();
    expect(ranking.read(neighbor).related).toMatchObject([
      { sessionId: original, kind: "related", sessionIsSource: false, removable: true },
    ]);

    await links.remove({ sessionId: neighbor, targetSessionId: original });
    expect(storedKinds()).toEqual([]);
    await ranking.whenIdle();
    expect(ranking.read(original).related).toEqual([]);
  });
});
