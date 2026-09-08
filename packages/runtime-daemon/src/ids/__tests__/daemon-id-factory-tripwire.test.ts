// Tripwire: no daemon module outside `src/ids/` mints an id with
// `crypto.randomUUID()` unless it is on the allow-list below.
//
// Why a test rather than a lint rule
// ----------------------------------
//
// The rule this enforces has two halves — "no `randomUUID` here" and "these
// exact files may, for these reasons" — and the second half is a data table
// with prose in it. ESLint's `no-restricted-syntax` can carry the first half,
// but flat config REPLACES a rule's options at the last matching config
// object, and `packages/runtime-daemon/src/**` already has a
// `no-restricted-syntax` invocation (the `UnsignedPlaceholderAppendToken`
// test-only-append guard). Exempting four paths there would mean a second
// config object that silently drops the append guard for exactly those files,
// or duplicating it. A test keeps one list, keeps each exemption's reason on
// the line it exempts, and reads the source tree the same way a reviewer does.
//
// What it does NOT claim: it reads text, not an AST, so it sees the token and
// not the call graph. That is enough — the failure mode it exists to catch is
// a new default id factory being written the old way, and the old way is
// spelled `randomUUID` every time. Prose counts too, deliberately: the comment
// that called `crypto.randomUUID()` "the established daemon id idiom" is how
// the next author learned the wrong idiom, so a stale mention is a finding and
// not noise.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const DAEMON_SOURCE_ROOT: string = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The (b) set: every daemon module that may name `randomUUID`, with the reason.
 * The minting entries are all ephemeral tokens — no row and no event stores
 * them, and nothing sorts a set of them — so uniqueness is the whole
 * requirement and v4 supplies it. The prose-only entries mint nothing and
 * describe a module that is itself on this list.
 *
 * Paths are `/`-separated and relative to `packages/runtime-daemon/src`.
 */
const RANDOM_UUID_MENTION_ALLOW_LIST: ReadonlyMap<string, string> = new Map([
  [
    "provider/drivers/outbound-frame.ts",
    "in-flight correlation token for one outbound frame; gone when the leg settles",
  ],
  [
    "ipc/streaming-primitive.ts",
    "in-memory subscription id, alive for the life of one transport connection",
  ],
  [
    "git/turn-snapshot-service.ts",
    "collision-free filename for a scratch git index unlinked in the same call",
  ],
  [
    "pty/node-pty-host.ts",
    "host-local PTY handle; the Rust sidecar backend mints `s-{n}` for the same field",
  ],
  [
    "ipc/handlers/presence-subscribe.ts",
    "prose only — describes `streaming-primitive.ts`'s subscription id, mints nothing",
  ],
  [
    "ipc/handlers/session-subscribe.ts",
    "prose only — describes `streaming-primitive.ts`'s subscription id, mints nothing",
  ],
]);

/** Test directories the sweep never descends into, at any depth. */
const SKIPPED_DIRECTORY_NAME = "__tests__";

/** The generator's own home — the one place `randomUUID` is legitimately discussed. */
const GENERATOR_DIRECTORY: string = join(DAEMON_SOURCE_ROOT, "ids");

/** A `randomUUID` mention and where it was found. */
interface RandomUuidMention {
  readonly relativePath: string;
  readonly lineNumber: number;
  readonly lineText: string;
}

/** Walks the daemon's non-test sources outside `ids/`, yielding `.ts` file paths. */
function collectDaemonSourceFiles(directory: string): string[] {
  const collected: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute: string = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === SKIPPED_DIRECTORY_NAME || absolute === GENERATOR_DIRECTORY) {
        continue;
      }
      collected.push(...collectDaemonSourceFiles(absolute));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      collected.push(absolute);
    }
  }
  return collected;
}

/** Every `randomUUID` mention in the daemon's non-test sources outside `ids/`. */
function findRandomUuidMentions(): RandomUuidMention[] {
  const mentions: RandomUuidMention[] = [];
  for (const absolutePath of collectDaemonSourceFiles(DAEMON_SOURCE_ROOT)) {
    const relativePath: string = relative(DAEMON_SOURCE_ROOT, absolutePath).split(sep).join("/");
    const lines: string[] = readFileSync(absolutePath, "utf8").split("\n");
    lines.forEach((lineText: string, lineIndex: number) => {
      if (lineText.includes("randomUUID")) {
        mentions.push({ relativePath, lineNumber: lineIndex + 1, lineText: lineText.trim() });
      }
    });
  }
  return mentions;
}

describe("daemon id factories mint through `ids/uuid-v7.ts`", () => {
  it("finds no `randomUUID` outside `ids/` beyond the allow-list", () => {
    const offenders: RandomUuidMention[] = findRandomUuidMentions().filter(
      (mention: RandomUuidMention) => !RANDOM_UUID_MENTION_ALLOW_LIST.has(mention.relativePath),
    );

    expect(
      offenders.map(
        (mention: RandomUuidMention) =>
          `${mention.relativePath}:${String(mention.lineNumber)} — ${mention.lineText}`,
      ),
      "`crypto.randomUUID()` emits UUID v4. Every daemon persisted-row id and " +
        "event id must mint through `mintUuidV7` (`src/ids/uuid-v7.ts`), because " +
        "`packages/contracts/src/session.ts` and `event.ts` both state that " +
        "daemon-assigned ids are RFC 9562 UUIDv7. If this really is an ephemeral " +
        "token that no row and no event stores — or prose about one — add the " +
        "file to `RANDOM_UUID_MENTION_ALLOW_LIST` with the reason on the line.",
    ).toStrictEqual([]);
  });

  it("keeps the allow-list honest — every entry still names a real file that mentions it", () => {
    const mentionedPaths: ReadonlySet<string> = new Set(
      findRandomUuidMentions().map((mention: RandomUuidMention) => mention.relativePath),
    );
    const staleEntries: string[] = [...RANDOM_UUID_MENTION_ALLOW_LIST.keys()].filter(
      (allowedPath: string) => !mentionedPaths.has(allowedPath),
    );

    expect(
      staleEntries,
      "An allow-list entry whose file no longer mentions `randomUUID` is a hole " +
        "held open for nothing. Delete the entry.",
    ).toStrictEqual([]);
  });

  it("sweeps a real tree — the walk reaches the modules that were migrated", () => {
    const sweptPaths: ReadonlySet<string> = new Set(
      collectDaemonSourceFiles(DAEMON_SOURCE_ROOT).map((absolutePath: string) =>
        relative(DAEMON_SOURCE_ROOT, absolutePath).split(sep).join("/"),
      ),
    );

    // A green result is only meaningful if the walk actually visited the files
    // the sweep moved onto `mintUuidV7`; an empty walk would pass vacuously.
    expect(sweptPaths.has("workspace/workspace-service.ts")).toBe(true);
    expect(sweptPaths.has("events/compactor.ts")).toBe(true);
    expect(sweptPaths.has("provider/drivers/codex/lifecycle.ts")).toBe(true);
    expect(sweptPaths.size).toBeGreaterThan(50);
  });
});
