// What removing a tree would lose, read from git in the tree: its uncommitted entries, its
// ignored entries (an `.env`, say), and the commits no remote-tracking branch reaches.

import { createHash } from "node:crypto";

import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { WorktreeRemovalRisks } from "@ai-sidekicks/contracts/worktree/lifecycle";

import type { GitCommand } from "../process.js";

// Porcelain v1 entries whose status names a second path, which `-z` prints as the next field.
const RENAME_OR_COPY_STATUS = /^[RC]|^.[RC]/;
const IGNORED_STATUS = "!!";

/**
 * The tree's risks as git reads them now, with the sessions standing in it. Uncommitted entries
 * are counted file by file, each untracked file on its own; ignored entries are counted as the
 * ignore rules match them, a wholly ignored folder once, so the read stays bounded on a tree with
 * a large ignored folder. Both reads take no optional lock, so they never rewrite the tree's index
 * under a run working there. The reads run one after another, one git process at a time.
 */
export async function readRemovalRisks(
  runGit: GitCommand,
  folder: string,
  occupyingSessionIds: readonly SessionId[],
): Promise<WorktreeRemovalRisks> {
  const entries = await readStatusEntries(runGit, folder);
  const unpushedCommitCount = await readUnpushedCommitCount(runGit, folder);
  return risksOf(entries, unpushedCommitCount, occupyingSessionIds);
}

/** What the risk read shows in a tree, and a digest of every entry and commit behind it. */
export interface RemovalRiskReading {
  readonly risks: WorktreeRemovalRisks;
  /**
   * Equal for two reads that show the same uncommitted and ignored entries, the same HEAD and the
   * same count of unpushed commits; a change inside a file git already lists leaves it equal.
   */
  readonly digest: string;
}

/** The risk read with its digest, for a tree no session stands in. */
export async function readRemovalRiskReading(
  runGit: GitCommand,
  folder: string,
): Promise<RemovalRiskReading> {
  const entries = await readStatusEntries(runGit, folder);
  const unpushedCommitCount = await readUnpushedCommitCount(runGit, folder);
  const head = await runGit(["--no-optional-locks", "-C", folder, "rev-parse", "--verify", "HEAD"]);
  const digest = createHash("sha256");
  for (const entry of [...entries].sort()) {
    digest.update(`${entry}\0`);
  }
  digest.update(`${head.stdout.toString("utf8").trim()}\0${String(unpushedCommitCount)}`);
  return { risks: risksOf(entries, unpushedCommitCount, []), digest: digest.digest("hex") };
}

// Each porcelain entry with its status code, a rename's or copy's source path joined to it.
async function readStatusEntries(runGit: GitCommand, folder: string): Promise<string[]> {
  const status = await runGit([
    "--no-optional-locks",
    "-C",
    folder,
    "status",
    "--porcelain=v1",
    "-z",
    "--ignored=matching",
    "--untracked-files=all",
  ]);
  const entries: string[] = [];
  const fields = status.stdout.toString("utf8").split("\0");
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index] ?? "";
    if (entry.length === 0) {
      continue;
    }
    if (RENAME_OR_COPY_STATUS.test(entry.slice(0, 2))) {
      index += 1;
      entries.push(`${entry}\0${fields[index] ?? ""}`);
    } else {
      entries.push(entry);
    }
  }
  return entries;
}

// The commits HEAD reaches that no remote-tracking branch does.
async function readUnpushedCommitCount(runGit: GitCommand, folder: string): Promise<number> {
  const unpushed = await runGit([
    "--no-optional-locks",
    "-C",
    folder,
    "rev-list",
    "--count",
    "HEAD",
    "--not",
    "--remotes",
  ]);
  return Number.parseInt(unpushed.stdout.toString("utf8").trim(), 10);
}

function risksOf(
  entries: readonly string[],
  unpushedCommitCount: number,
  occupyingSessionIds: readonly SessionId[],
): WorktreeRemovalRisks {
  const ignoredFileCount = entries.filter((entry) => entry.startsWith(IGNORED_STATUS)).length;
  return {
    uncommittedFileCount: entries.length - ignoredFileCount,
    ignoredFileCount,
    unpushedCommitCount,
    occupyingSessionIds: [...occupyingSessionIds],
  };
}

/** Whether a plain removal would lose anything: uncommitted, ignored or unpushed work. */
export function hasSomethingToLose(risks: WorktreeRemovalRisks): boolean {
  return (
    risks.uncommittedFileCount > 0 || risks.ignoredFileCount > 0 || risks.unpushedCommitCount > 0
  );
}
