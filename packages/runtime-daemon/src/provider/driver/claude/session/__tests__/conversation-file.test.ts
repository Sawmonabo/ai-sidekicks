// `conversation-file.ts` purge: every file Claude Code keeps for one conversation goes, and no file
// of another conversation in the same home, nor a path a plan name read off the file points at.

import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { deleteClaudeConversation } from "../conversation-file.js";

const PURGED = "11111111-1111-4111-8111-111111111111";
const KEPT = "22222222-2222-4222-8222-222222222222";

let configFolder: string | undefined;

afterEach(async () => {
  if (configFolder !== undefined) {
    await rm(configFolder, { recursive: true, force: true });
    configFolder = undefined;
  }
});

// Writes the files Claude Code keeps for `conversationId`, its entries naming `planSlug`.
async function writeConversation(
  folder: string,
  conversationId: string,
  planSlug: string,
): Promise<void> {
  const project = path.join(folder, "projects", "-workspace");
  await mkdir(path.join(project, conversationId, "subagents"), { recursive: true });
  await writeFile(
    path.join(project, `${conversationId}.jsonl`),
    `not json\n${JSON.stringify({ type: "user", uuid: "u1", slug: planSlug })}\n`,
  );
  await writeFile(path.join(project, conversationId, "subagents", "agent-1.jsonl"), "{}\n");
  for (const kept of ["file-history", "session-env", "tasks"]) {
    await mkdir(path.join(folder, kept, conversationId), { recursive: true });
    await writeFile(path.join(folder, kept, conversationId, "entry"), "x");
  }
  await mkdir(path.join(folder, "debug"), { recursive: true });
  await writeFile(path.join(folder, "debug", `${conversationId}.txt`), "log");
  await mkdir(path.join(folder, "plans"), { recursive: true });
  await writeFile(path.join(folder, "plans", `${planSlug}.md`), "# plan");
  await writeFile(path.join(folder, "plans", `${planSlug}-agent-a1.md`), "# helper plan");
}

// Every file under `folder`, relative to it.
async function listFiles(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(folder, path.join(entry.parentPath, entry.name)))
    .sort();
}

describe("deleteClaudeConversation", () => {
  it("removes every file of the purged conversation and none of another", async () => {
    configFolder = await mkdtemp(path.join(os.tmpdir(), "claude-purge-"));
    await writeConversation(configFolder, PURGED, "purged-plan-slug");
    await writeConversation(configFolder, KEPT, "kept-plan-slug");
    const keptFiles = (await listFiles(configFolder)).filter((file) => !file.includes(PURGED));

    await deleteClaudeConversation(configFolder, path.join(configFolder, "project"), PURGED);

    expect(await listFiles(configFolder)).toStrictEqual(
      keptFiles.filter((file) => !file.startsWith(path.join("plans", "purged-plan-slug"))),
    );
  });

  it("follows no plan name that would reach outside the plans folder", async () => {
    configFolder = await mkdtemp(path.join(os.tmpdir(), "claude-purge-"));
    await writeConversation(configFolder, PURGED, "../settings");
    await writeFile(path.join(configFolder, "settings.md"), "kept");

    await deleteClaudeConversation(configFolder, path.join(configFolder, "project"), PURGED);

    expect(await listFiles(configFolder)).toContain("settings.md");
  });
});
