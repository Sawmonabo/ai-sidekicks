// A session sits in at most one group of its project, a name is held once per project ignoring
// case, and no group is ever left empty. Each verb runs through the real writer on a real
// database, and every assertion reads the rows back.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RepoMountId } from "@ai-sidekicks/contracts/repo/mount";
import {
  SESSION_GROUP_NAME_TAKEN_CODE,
  SESSION_GROUP_REFUSED_CODE,
} from "@ai-sidekicks/contracts/session/groups";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import {
  openScratchDatabase,
  type ScratchDatabase,
} from "../../../database/__fixtures__/scratch.js";
import { WriteRefusedError } from "../../../database/writer.js";
import {
  seedChatSession,
  seedProjectMount,
  seedProjectSession,
} from "../../directory/__fixtures__/directory-rows.js";
import { SessionGroupService } from "../service.js";
import { sessionGroupPlacementStatement } from "../store.js";

let scratch: ScratchDatabase;
let refreshed: SessionId[][];
let groups: SessionGroupService;
let project: RepoMountId;

beforeEach(async () => {
  scratch = await openScratchDatabase();
  refreshed = [];
  groups = new SessionGroupService({
    writer: scratch.writer,
    listFeed: {
      refresh: (sessionIds) => {
        refreshed.push([...sessionIds]);
      },
    },
  });
  project = await seedProjectMount(scratch.writer);
});

afterEach(async () => {
  await scratch.close();
});

function groupOf(sessionId: SessionId): string | null {
  const row = scratch.reader
    .prepare("SELECT group_id FROM sessions WHERE id = ?")
    .get(sessionId) as { group_id: string | null } | undefined;
  if (row === undefined) {
    throw new Error(`no sessions row for ${sessionId}`);
  }
  return row.group_id;
}

function groupNames(): string[] {
  return (
    scratch.reader.prepare("SELECT name FROM session_groups ORDER BY name").all() as {
      name: string;
    }[]
  ).map((row) => row.name);
}

describe("a group's name", () => {
  it("is held once per project under the full case fold, and free in another project", async () => {
    const first = await seedProjectSession(scratch.writer, project);
    const second = await seedProjectSession(scratch.writer, project);
    await groups.create({ sessionId: first, name: "Straße" });

    // A lower-casing compare would let `STRASSE` through; the full fold makes it the same name.
    await expect(groups.create({ sessionId: second, name: "STRASSE" })).rejects.toMatchObject({
      code: SESSION_GROUP_NAME_TAKEN_CODE,
    });
    expect(groupOf(second)).toBeNull();
    expect(groupNames()).toEqual(["Straße"]);

    const otherProject = await seedProjectMount(scratch.writer);
    const elsewhere = await seedProjectSession(scratch.writer, otherProject);
    await groups.create({ sessionId: elsewhere, name: "strasse" });
    expect(groupNames()).toEqual(["Straße", "strasse"]);
  });

  it("refuses a rename onto another group's name and allows a new casing of its own", async () => {
    const first = await seedProjectSession(scratch.writer, project);
    const second = await seedProjectSession(scratch.writer, project);
    await groups.create({ sessionId: first, name: "auth work" });
    const { groupId } = await groups.create({ sessionId: second, name: "billing" });

    await expect(groups.rename({ groupId, name: "AUTH WORK" })).rejects.toMatchObject({
      code: SESSION_GROUP_NAME_TAKEN_CODE,
    });
    await groups.rename({ groupId, name: "Billing" });
    expect(groupNames()).toEqual(["Billing", "auth work"]);
  });
});

describe("a session's group", () => {
  it("is one group of its own project, and a chat sits in none", async () => {
    const session = await seedProjectSession(scratch.writer, project);
    const { groupId: firstGroup } = await groups.create({ sessionId: session, name: "first" });
    const { groupId: secondGroup } = await groups.create({ sessionId: session, name: "second" });

    // Making the second group moved the session out of the first, which it left empty.
    expect(groupOf(session)).toBe(secondGroup);
    expect(groupNames()).toEqual(["second"]);
    expect(firstGroup).not.toBe(secondGroup);

    const otherProject = await seedProjectMount(scratch.writer);
    const stranger = await seedProjectSession(scratch.writer, otherProject);
    await expect(groups.move({ sessionId: stranger, groupId: secondGroup })).rejects.toMatchObject({
      code: SESSION_GROUP_REFUSED_CODE,
    });
    expect(groupOf(stranger)).toBeNull();

    const chat = await seedChatSession(scratch.writer);
    await expect(groups.create({ sessionId: chat, name: "chats" })).rejects.toMatchObject({
      code: SESSION_GROUP_REFUSED_CODE,
    });
    await expect(groups.move({ sessionId: chat, groupId: secondGroup })).rejects.toMatchObject({
      code: SESSION_GROUP_REFUSED_CODE,
    });
    expect(groupOf(chat)).toBeNull();
    expect(groupNames()).toEqual(["second"]);
  });

  it("placed at create holds only for a group of the session's own project", async () => {
    const owner = await seedProjectSession(scratch.writer, project);
    const { groupId } = await groups.create({ sessionId: owner, name: "auth work" });
    const chat = await seedChatSession(scratch.writer);
    const otherProject = await seedProjectMount(scratch.writer);
    const stranger = await seedProjectSession(scratch.writer, otherProject);
    const sibling = await seedProjectSession(scratch.writer, project);

    for (const sessionId of [chat, stranger]) {
      await expect(
        scratch.writer.write([sessionGroupPlacementStatement({ sessionId, groupId })]),
      ).rejects.toBeInstanceOf(WriteRefusedError);
      expect(groupOf(sessionId)).toBeNull();
    }
    await scratch.writer.write([sessionGroupPlacementStatement({ sessionId: sibling, groupId })]);
    expect(groupOf(sibling)).toBe(groupId);
  });
});

describe("leaving a group", () => {
  it("removes the group with its last session, in the same write", async () => {
    const first = await seedProjectSession(scratch.writer, project);
    const second = await seedProjectSession(scratch.writer, project);
    const { groupId } = await groups.create({ sessionId: first, name: "auth work" });
    await groups.move({ sessionId: second, groupId });

    await groups.move({ sessionId: first, groupId: null });
    expect(groupNames()).toEqual(["auth work"]);
    await groups.move({ sessionId: second, groupId: null });
    expect(groupNames()).toEqual([]);
    expect([groupOf(first), groupOf(second)]).toEqual([null, null]);
    expect(refreshed.at(-1)).toEqual([second]);
  });

  it("by ungrouping puts every session back loose and tells the list about each", async () => {
    const first = await seedProjectSession(scratch.writer, project);
    const second = await seedProjectSession(scratch.writer, project);
    const { groupId } = await groups.create({ sessionId: first, name: "auth work" });
    await groups.move({ sessionId: second, groupId });
    refreshed = [];

    await groups.ungroup({ groupId });
    expect(groupNames()).toEqual([]);
    expect([groupOf(first), groupOf(second)]).toEqual([null, null]);
    expect(refreshed.flat().sort()).toEqual([first, second].sort());
  });
});
