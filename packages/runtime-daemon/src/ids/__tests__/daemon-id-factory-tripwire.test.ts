// Tripwire: no daemon module outside `src/ids/` mints an id with
// `crypto.randomUUID()` unless that exact source line is on the allow-list
// below.
//
// Why the allow-list is keyed by occurrence and not by file
// --------------------------------------------------------
//
// An earlier shape exempted whole PATHS. That is the wrong unit: a file earns
// its exemption for one ephemeral token, and the exemption then covers every
// future line in it. Add a persisted-row or event id factory to an exempted
// file and the tripwire stays green — it drops the offender solely because the
// path is approved, which is the exact regression this test exists to catch.
// So the unit is the `(path, exact trimmed line text)` pair, and the list
// carries every `randomUUID` mention those files hold today, code and prose,
// with the reason on the line it exempts.
//
// The pairing runs in both directions. An unlisted mention in a listed file is
// an offender, and a listed pair whose source line is gone is a hole held open
// for nothing — reported by pair, so the list cannot rot into a stale blanket.
//
// Why a test rather than a lint rule
// ----------------------------------
//
// The rule this enforces has two halves — "no `randomUUID` here" and "these
// exact lines may, for these reasons" — and the second half is a data table
// with prose in it. ESLint's `no-restricted-syntax` can carry the first half,
// but flat config REPLACES a rule's options at the last matching config
// object, and `packages/runtime-daemon/src/**` already has a
// `no-restricted-syntax` invocation (the `UnsignedPlaceholderAppendToken`
// test-only-append guard). Exempting the thirteen occurrences across six paths
// below would mean a second config object that silently drops the append guard
// for exactly those files, or duplicating it — and a selector cannot express
// "this call site but not the next one added beside it" at all, which is the
// half that matters most. A test keeps one list, keeps each exemption's reason
// on the line it exempts, and reads the source tree the same way a reviewer
// does.
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

/** One exempt mention: the exact trimmed source line, and why it may stand. */
interface ExemptOccurrence {
  readonly lineText: string;
  readonly reason: string;
}

/**
 * The (b) set: every `randomUUID` line the daemon may hold outside `ids/`.
 *
 * The minting entries are all ephemeral tokens — no row and no event stores
 * them, and nothing sorts a set of them — so uniqueness is the whole
 * requirement and v4 supplies it. The import entries pull the minter in for one
 * of those call sites. The prose entries mint nothing and describe a call site
 * that is itself on this list.
 *
 * Paths are `/`-separated and relative to `packages/runtime-daemon/src`; line
 * texts are compared after `String.prototype.trim()`, so indentation may move.
 */
const RANDOM_UUID_OCCURRENCE_ALLOW_LIST: ReadonlyMap<string, readonly ExemptOccurrence[]> = new Map(
  [
    [
      "provider/drivers/outbound-frame.ts",
      [
        {
          lineText: 'import { randomUUID } from "node:crypto";',
          reason: "pulls the token minter in for the correlation-id default below",
        },
        {
          lineText:
            "this.#mintCorrelationId = options.mintCorrelationId ?? ((): string => randomUUID());",
          reason: "in-flight correlation token for one outbound frame; gone when the leg settles",
        },
      ],
    ],
    [
      "ipc/streaming-primitive.ts",
      [
        {
          lineText: "// `subscriptionId` is a UUID string at runtime; `crypto.randomUUID()`",
          reason: "prose on the branded-type declaration, describing the mint below",
        },
        {
          lineText: "* `subscriptionId` is generated via `crypto.randomUUID()` (Node 22.12+",
          reason: "prose on the subscribe API's doc comment, describing the mint below",
        },
        {
          lineText: "// Branding cast: `crypto.randomUUID()` returns `string`. The runtime",
          reason: "prose explaining the branding cast applied on the mint below",
        },
        {
          lineText: "const subscriptionId = crypto.randomUUID() as SubscriptionId;",
          reason: "in-memory subscription id, alive for the life of one transport connection",
        },
      ],
    ],
    [
      "git/turn-snapshot-service.ts",
      [
        {
          lineText:
            "// concatenation and `randomUUID`), which is what lets the `try` start below them",
          reason: "prose naming the throw-free operations that precede the try block",
        },
        {
          lineText: 'import { createHash, randomUUID } from "node:crypto";',
          reason: "pulls the token minter in for the scratch-index filename below",
        },
        {
          lineText:
            "const scratchIndexPath: string = join(this.#snapshotIndexDirectory, `${randomUUID()}.index`);",
          reason: "collision-free filename for a scratch git index unlinked in the same call",
        },
      ],
    ],
    [
      "pty/node-pty-host.ts",
      [
        {
          lineText: 'import { randomUUID } from "node:crypto";',
          reason: "pulls the token minter in for the PTY handle below",
        },
        {
          lineText: "const sessionId: string = randomUUID();",
          reason:
            "host-local PTY handle; the Rust sidecar backend mints `s-{n}` for the same field",
        },
      ],
    ],
    [
      "ipc/handlers/presence-subscribe.ts",
      [
        {
          lineText: "// generates a fresh `subscriptionId` via `crypto.randomUUID()` and",
          reason:
            "prose only — describes `streaming-primitive.ts`'s subscription id, mints nothing",
        },
      ],
    ],
    [
      "ipc/handlers/session-subscribe.ts",
      [
        {
          lineText: "// generates a fresh `subscriptionId` via `crypto.randomUUID()` and",
          reason:
            "prose only — describes `streaming-primitive.ts`'s subscription id, mints nothing",
        },
      ],
    ],
  ],
);

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

/** `path lineText`, the pairing key both directions compare on. */
function occurrenceKey(relativePath: string, lineText: string): string {
  return `${relativePath} ${lineText}`;
}

/** Every allow-listed pair, flattened to its comparison key. */
function allowListedKeys(): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const [relativePath, occurrences] of RANDOM_UUID_OCCURRENCE_ALLOW_LIST) {
    for (const occurrence of occurrences) {
      keys.add(occurrenceKey(relativePath, occurrence.lineText));
    }
  }
  return keys;
}

describe("daemon id factories mint through `ids/uuid-v7.ts`", () => {
  it("finds no randomUUID mention outside ids beyond the allow-listed occurrences", () => {
    const mentions: RandomUuidMention[] = findRandomUuidMentions();
    const allowed: ReadonlySet<string> = allowListedKeys();

    // (i) Every mention in the tree is an allow-listed pair. A NEW line in an
    // already-listed file is an offender: the path buys nothing on its own.
    const offenders: string[] = mentions
      .filter(
        (mention: RandomUuidMention) =>
          !allowed.has(occurrenceKey(mention.relativePath, mention.lineText)),
      )
      .map(
        (mention: RandomUuidMention) =>
          `${mention.relativePath}:${String(mention.lineNumber)} — ${mention.lineText}`,
      );

    expect(
      offenders,
      "`crypto.randomUUID()` emits UUID v4. Every daemon persisted-row id and " +
        "event id must mint through `mintUuidV7` (`src/ids/uuid-v7.ts`), because " +
        "`packages/contracts/src/session.ts` and `event.ts` both state that " +
        "daemon-assigned ids are RFC 9562 UUIDv7. If this really is an ephemeral " +
        "token that no row and no event stores — or prose about one — add the " +
        "EXACT trimmed line to `RANDOM_UUID_OCCURRENCE_ALLOW_LIST` under its " +
        "path, with the reason beside it. Listing the path alone is not enough " +
        "and never was.",
    ).toStrictEqual([]);

    // (ii) Every allow-listed pair is still in its file. A pair whose source
    // line moved or vanished is a hole held open for nothing.
    const presentKeys: ReadonlySet<string> = new Set(
      mentions.map((mention: RandomUuidMention) =>
        occurrenceKey(mention.relativePath, mention.lineText),
      ),
    );
    const staleEntries: string[] = [];
    for (const [relativePath, occurrences] of RANDOM_UUID_OCCURRENCE_ALLOW_LIST) {
      for (const occurrence of occurrences) {
        if (!presentKeys.has(occurrenceKey(relativePath, occurrence.lineText))) {
          staleEntries.push(`${relativePath} — ${occurrence.lineText}`);
        }
      }
    }

    expect(
      staleEntries,
      "An allow-list pair whose source line no longer exists is a hole held " +
        "open for nothing — and left in place it degrades back into the " +
        "path-wide exemption this list replaced. Delete the pair, or update its " +
        "`lineText` if the line was only reworded.",
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
