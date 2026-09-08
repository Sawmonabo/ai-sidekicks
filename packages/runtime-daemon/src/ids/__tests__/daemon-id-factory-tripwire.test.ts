// Tripwire: no daemon module — the generator's own `src/ids/` included —
// mints an id with `crypto.randomUUID()` unless that exact source line is on
// the allow-list in `random-uuid-occurrence-allow-list.ts` beside this file.
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
// with the reason on the line it exempts. The generator's own directory gets
// no path-wide skip either: an earlier shape stepped over `src/ids/` whole,
// which would have hidden a helper minting a persisted id with `randomUUID()`
// beside the very generator that exists to replace it. Its explanatory prose
// is listed by occurrence like every other file's.
//
// Within a listed path the comparison is a MULTISET and deliberately not a
// set. A set would reopen a narrower version of the same hole: two identical
// trimmed lines collapse onto one member, so copying an already-exempt mint
// into a second scope of an exempt file reads as "already allowed", and the
// same collapse hides a deleted occurrence whose twin still stands. Comparing
// the file's mention texts against the listed ones occurrence for occurrence
// closes both, and closes them in one comparison rather than two checks that
// could disagree — an unexpected text lands on the actual side, a vanished one
// on the expected side. So a duplicated line needs its own list entry, with
// its own reason, exactly as a new line does.
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
// test-only-append guard). Exempting the seventeen occurrences across seven paths
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

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  type ExemptOccurrence,
  RANDOM_UUID_OCCURRENCE_ALLOW_LIST,
} from "./random-uuid-occurrence-allow-list.js";

const DAEMON_SOURCE_ROOT: string = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Test directories the sweep never descends into, at any depth. */
const SKIPPED_DIRECTORY_NAME = "__tests__";

/** A `randomUUID` mention and where it was found. */
interface RandomUuidMention {
  readonly relativePath: string;
  readonly lineNumber: number;
  readonly lineText: string;
}

/** Walks the non-test sources under `directory`, yielding `.ts` file paths. */
function collectDaemonSourceFiles(directory: string): string[] {
  const collected: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute: string = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === SKIPPED_DIRECTORY_NAME) {
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

/** Every `randomUUID` mention in the non-test sources under `sourceRoot`. */
function findRandomUuidMentions(sourceRoot: string): RandomUuidMention[] {
  const mentions: RandomUuidMention[] = [];
  for (const absolutePath of collectDaemonSourceFiles(sourceRoot)) {
    const relativePath: string = relative(sourceRoot, absolutePath).split(sep).join("/");
    const lines: string[] = readFileSync(absolutePath, "utf8").split("\n");
    lines.forEach((lineText: string, lineIndex: number) => {
      if (lineText.includes("randomUUID")) {
        mentions.push({ relativePath, lineNumber: lineIndex + 1, lineText: lineText.trim() });
      }
    });
  }
  return mentions;
}

/**
 * The allow-listed line texts for one path, sorted — one entry per exempt
 * occurrence, so two identical exempt lines are two entries and not one.
 */
function allowListedTextsFor(relativePath: string): string[] {
  const occurrences: readonly ExemptOccurrence[] =
    RANDOM_UUID_OCCURRENCE_ALLOW_LIST.get(relativePath) ?? [];
  return occurrences.map((occurrence: ExemptOccurrence) => occurrence.lineText).sort();
}

/** The `randomUUID` line texts each path actually holds, sorted, one per mention. */
function mentionTextsByPath(mentions: readonly RandomUuidMention[]): ReadonlyMap<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const mention of mentions) {
    const texts: string[] = grouped.get(mention.relativePath) ?? [];
    texts.push(mention.lineText);
    grouped.set(mention.relativePath, texts);
  }
  for (const texts of grouped.values()) {
    texts.sort();
  }
  return grouped;
}

/**
 * (i) Mentions in a path the allow-list does not name at all — each reported
 * with its line number so a reviewer can go read it.
 */
function offendersAmong(mentions: readonly RandomUuidMention[]): string[] {
  return mentions
    .filter(
      (mention: RandomUuidMention) => !RANDOM_UUID_OCCURRENCE_ALLOW_LIST.has(mention.relativePath),
    )
    .map(
      (mention: RandomUuidMention) =>
        `${mention.relativePath}:${String(mention.lineNumber)} ${mention.lineText}`,
    );
}

/** One listed path whose file and allow-list disagree, with both sides shown. */
interface DriftedPath {
  readonly relativePath: string;
  readonly onlyInFile: readonly string[];
  readonly onlyInAllowList: readonly string[];
}

/** Multiset difference: every element of `left` not matched one-for-one in `right`. */
function unmatchedOccurrences(left: readonly string[], right: readonly string[]): string[] {
  const remaining: string[] = [...right];
  const unmatched: string[] = [];
  for (const text of left) {
    const matchIndex: number = remaining.indexOf(text);
    if (matchIndex === -1) {
      unmatched.push(text);
    } else {
      remaining.splice(matchIndex, 1);
    }
  }
  return unmatched;
}

/**
 * (ii) Inside an allow-listed path, the file's mentions and the list must
 * agree as MULTISETS. Comparing SETS would be a hole: a second copy of an
 * already-exempt line collapses onto the same member, so duplicating a mint
 * into another scope of an exempt file reads as "already allowed" — and the
 * same collapse makes a deleted occurrence look present while its twin
 * survives. Counting closes both, and closes them in ONE comparison: an
 * unexpected text (new, or a duplicate of a listed one) shows up as only in
 * the file, a vanished one as only in the allow-list.
 */
function driftedPathsAmong(mentions: readonly RandomUuidMention[]): DriftedPath[] {
  const actualTextsByPath: ReadonlyMap<string, string[]> = mentionTextsByPath(mentions);
  const drifted: DriftedPath[] = [];
  for (const relativePath of RANDOM_UUID_OCCURRENCE_ALLOW_LIST.keys()) {
    const inFile: string[] = actualTextsByPath.get(relativePath) ?? [];
    const inAllowList: string[] = allowListedTextsFor(relativePath);
    const onlyInFile: string[] = unmatchedOccurrences(inFile, inAllowList);
    const onlyInAllowList: string[] = unmatchedOccurrences(inAllowList, inFile);
    if (onlyInFile.length > 0 || onlyInAllowList.length > 0) {
      drifted.push({ relativePath, onlyInFile, onlyInAllowList });
    }
  }
  return drifted;
}

/** A throwaway source root holding exactly the files given, for planting offenders. */
function withPlantedSourceRoot<T>(
  files: Readonly<Record<string, string>>,
  body: (sourceRoot: string) => T,
): T {
  const sourceRoot: string = mkdtempSync(join(tmpdir(), "daemon-id-tripwire-"));
  try {
    for (const [relativePath, contents] of Object.entries(files)) {
      const absolutePath: string = join(sourceRoot, ...relativePath.split("/"));
      mkdirSync(dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, contents);
    }
    return body(sourceRoot);
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true });
  }
}

describe("daemon id factories mint through `ids/uuid-v7.ts`", () => {
  it("finds no randomUUID mention beyond the allow-listed occurrences", () => {
    const mentions: RandomUuidMention[] = findRandomUuidMentions(DAEMON_SOURCE_ROOT);

    expect(
      offendersAmong(mentions),
      "`crypto.randomUUID()` emits UUID v4. Every daemon persisted-row id and " +
        "event id must mint through `mintUuidV7` (`src/ids/uuid-v7.ts`), because " +
        "`packages/contracts/src/session.ts` and `event.ts` both state that " +
        "daemon-assigned ids are RFC 9562 UUIDv7. If this really is an ephemeral " +
        "token that no row and no event stores, or prose about one, add the " +
        "EXACT trimmed line to `RANDOM_UUID_OCCURRENCE_ALLOW_LIST` under its " +
        "path, with the reason beside it. Listing the path alone is not enough " +
        "and never was.",
    ).toStrictEqual([]);

    expect(
      driftedPathsAmong(mentions),
      "A listed path no longer matches its allow-list entry occurrence for " +
        "occurrence. A line only the FILE has is an unexempted mention: add it " +
        "to `RANDOM_UUID_OCCURRENCE_ALLOW_LIST` with its own reason if it is " +
        "genuinely an ephemeral token, and note that a second copy of an " +
        "already-listed line needs its own entry. A line only the ALLOW-LIST " +
        "has is a hole held open for nothing: delete that entry, or update its " +
        "`lineText` if the line was merely reworded.",
    ).toStrictEqual([]);
  });

  it("sweeps a real tree — the walk reaches the modules that were migrated", () => {
    const sweptPaths: ReadonlySet<string> = new Set(
      collectDaemonSourceFiles(DAEMON_SOURCE_ROOT).map((absolutePath: string) =>
        relative(DAEMON_SOURCE_ROOT, absolutePath).split(sep).join("/"),
      ),
    );

    // A green result is only meaningful if the walk actually visited the files
    // the sweep moved onto `mintUuidV7` — and the generator itself, which an
    // earlier shape stepped over whole; an empty walk would pass vacuously.
    expect(sweptPaths.has("ids/uuid-v7.ts")).toBe(true);
    expect(sweptPaths.has("workspace/workspace-service.ts")).toBe(true);
    expect(sweptPaths.has("events/compactor.ts")).toBe(true);
    expect(sweptPaths.has("provider/drivers/codex/lifecycle.ts")).toBe(true);
    expect(sweptPaths.size).toBeGreaterThan(50);
  });

  it("negative control: a randomUUID mint planted beside the generator is an offender", () => {
    // The generator's directory earns no path-wide skip. A helper added there
    // that mints with `randomUUID()` is reported exactly as one anywhere else.
    const offenders: string[] = withPlantedSourceRoot(
      {
        "ids/helper.ts":
          'import { randomUUID } from "node:crypto";\n' +
          "export const mintHelperId = (): string => randomUUID();\n",
      },
      (sourceRoot: string) => offendersAmong(findRandomUuidMentions(sourceRoot)),
    );

    expect(offenders).toStrictEqual([
      'ids/helper.ts:1 import { randomUUID } from "node:crypto";',
      "ids/helper.ts:2 export const mintHelperId = (): string => randomUUID();",
    ]);
  });

  it("negative control: an unlisted randomUUID line inside the generator itself drifts", () => {
    // Even the generator's own file is exempt only occurrence for occurrence:
    // its four listed prose lines pass, and a fifth mention — a real mint
    // added beneath them — lands on the file-only side of the comparison.
    const listedProse: string = allowListedTextsFor("ids/uuid-v7.ts").join("\n");
    const plantedMint = "export const mintFallbackId = (): string => randomUUID();";
    const drifted: DriftedPath[] = withPlantedSourceRoot(
      { "ids/uuid-v7.ts": `${listedProse}\n${plantedMint}\n` },
      (sourceRoot: string) => driftedPathsAmong(findRandomUuidMentions(sourceRoot)),
    ).filter((entry: DriftedPath) => entry.relativePath === "ids/uuid-v7.ts");

    expect(drifted).toStrictEqual([
      { relativePath: "ids/uuid-v7.ts", onlyInFile: [plantedMint], onlyInAllowList: [] },
    ]);
  });
});
