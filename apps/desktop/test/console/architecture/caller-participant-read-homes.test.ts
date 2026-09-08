// "Which participant is this window" has one composition, and the census says which.
//
// The growth port's `callerParticipantRead` answers a fact three sibling view families
// gate controls on, and the two halves of reading it live in families that cannot reach
// each other: the call is in `bridge/`, and the hook that chains an identity to the
// session roster is in `store/`, which sits below it and takes the reader as an injected
// `CallerParticipantReader`. So every surface that wanted the answer wrote the adapter
// out for itself, and three of them wrote it character for character — including the
// comment. Sibling families cannot take each other's copy, so the second and third were
// unavoidable where they stood; `seats/identity/caller-participant.ts` is where they
// stop being three answers to one question.
//
// WHY A SOURCE CENSUS AND NOT A TYPE. A fourth hand-written adapter is type-correct —
// that is what makes it invisible — so the compiler has nothing to say about it, and the
// layering gate has nothing to say either: each copy sat in a family that may legally
// reach both the port and the store. The only statement that can be made is about WHICH
// MODULES name the seam at all.
//
// PINNED BY NAME, on `read-triggers.test.ts`'s rule. The walk can come back empty — a
// renamed directory, a changed extension — and a claim quantified over an empty set
// passes. Naming every module makes a disappearance a failure, and makes the next reader
// of this seam arrive here before it ships.

import { describe, expect, it } from "vitest";
import ts from "typescript";

import {
  consoleRelativePaths,
  consoleSourceModules,
  readConsoleSourceModule,
  type ConsoleSourceModule,
} from "../console-source-modules.js";
import { forEachDescendant, parseSourceText } from "../typescript-source.js";

/**
 * The store's injected caller-identity reader, by the name every namer of it uses.
 *
 * The type is the seam: a module that names it is either declaring it, publishing it, or
 * composing one — and composing one is the job this census holds to a single home.
 */
const READER_TYPE_NAME = "CallerParticipantReader";

/** The growth operation both halves are about. */
const IDENTITY_OPERATION_NAME = "callerParticipantRead";

/**
 * Every module that may name the reader type — the declaration, the door, the one
 * composition.
 *
 * Three and not one, because two of them are the seam being published rather than a
 * second answer to it: `store/hooks.ts` DECLARES the type and states that a composition
 * root must supply one, and `store/index.ts` is the family door that lets a family above
 * it read the declaration. A fourth name here is a surface composing its own adapter.
 */
const READER_TYPE_MODULES: readonly string[] = [
  "seats/identity/caller-participant.ts",
  "store/hooks.ts",
  "store/index.ts",
];

/**
 * Every module outside `bridge/` that puts the identity question on the wire.
 *
 * `bridge/` is subtracted rather than listed because it OWNS the operation — the port
 * declares it, the fixture answers it, and the scenarios script it — so a census over
 * that family would be pinning the wire rather than its readers.
 *
 * The four are three policies and one residual. The seat holds the two composed reads a
 * surface takes; the proposals family absorbs a non-answer into the absence its request
 * may omit; the notifications page publishes each arm onto something a person reads. The
 * fourth, `terminal/lease/viewer-identity.ts`, still holds its own subject-scoped effect
 * for the identity, which is the seat's job written a second time — it is named here so
 * the lane that folds it in changes this line rather than slipping past a claim about a
 * set it is silently in.
 */
const IDENTITY_CALL_MODULES: readonly string[] = [
  "repos/proposals/caller-participant-attribution.ts",
  "seats/identity/caller-participant.ts",
  "settings/pages/notifications/scheduled-caller-participant-read.ts",
  "terminal/lease/viewer-identity.ts",
];

/** Whether a parsed module names `CallerParticipantReader` in any position. */
function namesReaderType(parsed: ts.SourceFile): boolean {
  let found = false;
  forEachDescendant(parsed, (node) => {
    if (ts.isIdentifier(node) && node.text === READER_TYPE_NAME) {
      found = true;
    }
  });
  return found;
}

/** Whether a parsed module reaches `<something>.callerParticipantRead`. */
function callsIdentityOperation(parsed: ts.SourceFile): boolean {
  let found = false;
  forEachDescendant(parsed, (node) => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === IDENTITY_OPERATION_NAME) {
      found = true;
    }
  });
  return found;
}

/**
 * The walk and the parse, done ONCE for both claims.
 *
 * At module scope on the sibling gates' discipline: each claim below asks a different
 * question of the same tree, and parsing it per case parses the whole console twice for
 * one reading.
 */
function censusModules(): {
  readonly readerTypeNamers: readonly string[];
  readonly identityCallers: readonly string[];
} {
  const modules = consoleSourceModules({ tests: false });
  const readerTypeNamers: ConsoleSourceModule[] = [];
  const identityCallers: ConsoleSourceModule[] = [];
  for (const module of modules) {
    const parsed = parseSourceText(module.relativePath, readConsoleSourceModule(module));
    if (namesReaderType(parsed)) {
      readerTypeNamers.push(module);
    }
    if (callsIdentityOperation(parsed) && !module.displayPath.includes("/bridge/")) {
      identityCallers.push(module);
    }
  }
  return {
    readerTypeNamers: consoleRelativePaths(readerTypeNamers),
    identityCallers: consoleRelativePaths(identityCallers),
  };
}

const CENSUS = censusModules();

describe("the caller-participant read has one composition", () => {
  it("names the injected reader type in the declaration, the door, and one seat", () => {
    expect([...CENSUS.readerTypeNamers].sort()).toEqual([...READER_TYPE_MODULES].sort());
  });

  it("puts the identity question on the wire from the pinned modules only", () => {
    expect([...CENSUS.identityCallers].sort()).toEqual([...IDENTITY_CALL_MODULES].sort());
  });

  it("finds both spellings in a planted module, so a clean census is a reading", () => {
    const planted = parseSourceText(
      "planted-composition-root.ts",
      [
        "const readCallerParticipant: CallerParticipantReader = async () => {",
        "  const outcome = await bridge.growth.callerParticipantRead({ sessionId });",
        '  return outcome.status === "served" ? outcome.value.participantId : outcome;',
        "};",
      ].join("\n"),
    );
    expect(namesReaderType(planted)).toBe(true);
    expect(callsIdentityOperation(planted)).toBe(true);
  });

  it("reads neither spelling out of a comment that merely quotes it", () => {
    const quoted = parseSourceText(
      "quoting-module.ts",
      [
        "// The composition root adapts the port's outcome into a `CallerParticipantReader`,",
        "// which is what `bridge.growth.callerParticipantRead(request)` answers into.",
        "export const NOTHING = 1;",
      ].join("\n"),
    );
    expect(namesReaderType(quoted)).toBe(false);
    expect(callsIdentityOperation(quoted)).toBe(false);
  });
});
