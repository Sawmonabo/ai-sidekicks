// State that belongs to a subject is held in one place, and the build says so.
//
// WHY THIS FILE EXISTS. Subject-scoped state was the recurring finding across every
// console family: a pane rebound from one session to another kept the previous one's
// editor text, busy flag, roster, or outcome for a frame, and a call still in flight
// against the previous subject settled into the new one. Six family branches each
// found it, and each fixed it with its own holder and its own generation counter —
// five spellings of two things. The place copies of a guard drift is the PREDICATE,
// and a drifted predicate is a stale value on screen that every test still passes.
//
// So the console has exactly one holder and exactly one latch, and this is the
// tripwire that keeps it that way. It is a source-text check on the
// `wire-figure-chokepoint.test.ts` precedent: the claim is about what the tree
// CONTAINS, which no type and no runtime assertion can reach.
//
// TWO CLAIMS, DELIBERATELY DISJOINT.
//
//   1. NO SECOND IMPLEMENTATION. No module outside the chokepoints exports a hook or
//      class named like one of the copies this replaced. The one module admitted
//      beside them is a DOOR, and the check enforces exactly that: it must import the
//      chokepoint, so "door" is a fact about its imports rather than a promise in its
//      header.
//   2. NO HAND-ROLLED HOLDER. No `useState` or `useRef` initialiser anywhere under the
//      console names a bridge or a session id. That is how every one of the six copies
//      began — four lines in a component that needed to remember something about the
//      session it was looking at — and it is the shape that never arrives as a
//      deliberate decision.
//
// CLAIM 2 IS COARSE ON PURPOSE, and its false positives are named rather than tuned
// away. It flags a `useState(() => new SomethingBoundTo(bridge))` even where that
// something disposes itself correctly, and it flags a `useRef` holding a mutable
// handle that is never rendered. Both are the class this file is about — a value
// whose lifetime is a subject's, kept in a cell whose lifetime is a mount's — so the
// answer is to go through the holder, or to name the module in ADMITTED_SUBJECT_CELLS
// with the reason it is not that class. It is case-sensitive: `BridgeScopedLatch` in
// an initialiser is a construction and not a captured subject, and only the lower-case
// identifiers a component receives as props are the signature.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const RENDERER_SOURCE = resolve(HERE, "..", "..", "..", "src", "renderer", "src");

/** The renderer trees this console owns. `shell/` hosts the composer seat. */
const SCANNED_ROOTS: readonly string[] = ["console", "shell"];

/** The two modules that hold the rule, written as paths so a move is reviewable. */
const CHOKEPOINT_MODULES: readonly string[] = [
  join("console", "store", "subject-scoped-state.ts"),
  join("console", "store", "generation-latch.ts"),
];

/**
 * Modules admitted to re-export the vocabulary in another family's terms.
 *
 * A door adds no rule: it forwards. Admission is therefore conditional on IMPORTING a
 * chokepoint, asserted below, so a second implementation cannot be admitted by adding
 * its path here.
 */
const CHOKEPOINT_DOORS: readonly string[] = [
  join("console", "seats", "session-subject.ts"),
  join("console", "store", "index.ts"),
];

/**
 * The names the six replaced copies went by, as one expression.
 *
 * `Latch$` and `MutationAttempt$` are anchored because a state type named for one —
 * `MutationAttemptState` — is a caller's own vocabulary and not a second latch.
 * `AttemptGeneration` is not anchored: it was a whole class, and any name containing
 * it is that class under a prefix.
 */
const SECOND_IMPLEMENTATION_NAMES =
  /use(Subject|Session|Bridge)(Scoped|Stamped)|Latch$|AttemptGeneration|MutationAttempt$/;

/** What a hand-rolled holder captures: the two identities a surface is addressed by. */
const SUBJECT_IDENTIFIERS: readonly string[] = ["bridge", "sessionId"];

/**
 * Modules whose subject-named cell is not this class, each with its reason.
 *
 * The three entries are COMPOSITION ROOTS: each builds a window-lifetime resource
 * from the bridge it is handed at the top of the tree and replaces it from its own
 * disposal effect. They are not surfaces addressed by a prop that can move, which is
 * the class this file is about, and a holder keyed by subject would give a window's
 * database connection the lifetime of a route.
 *
 * An entry that stops tripping the checker fails the gate below rather than rotting
 * here, on the dead-code gate's own `@consumedBy` discipline: an exemption that
 * outlived its cause is deleted by the PR that removed the cause.
 */
const ADMITTED_SUBJECT_CELLS: Readonly<Record<string, string>> = {
  [join("console", "bridge", "BridgeProvider.tsx")]:
    "the console's single bridge chokepoint — it RESOLVES the bridge for the window " +
    "and re-resolves it when the prop changes, rather than being addressed by one",
  [join("console", "frame", "session-lifecycle.ts")]:
    "the window's session-store registry and event binder, built once and replaced " +
    "only when disposed; its lifetime is the window's, not a route's",
  [join("console", "frame", "ui-state-lifecycle.ts")]:
    "the window's one open UI-state database connection, on the same terms",
};

/** Every exported name in `source`, from a declaration or a re-export specifier. */
export function exportedSymbolNames(source: string): readonly string[] {
  const declared = [
    ...source.matchAll(
      /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm,
    ),
  ].map((match) => match[1] ?? "");
  const reExported = [...source.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}/gm)].flatMap((match) =>
    (match[1] ?? "")
      .split(",")
      .map((specifier) => specifier.replace(/\/\*[\s\S]*?\*\//g, "").trim())
      .filter((specifier) => specifier.length > 0)
      // `A as B` exports B; a bare `A` exports A. `type` prefixes are stripped.
      .map(
        (specifier) =>
          specifier
            .split(/\s+as\s+/)
            .at(-1)
            ?.replace(/^type\s+/, "")
            .trim() ?? "",
      ),
  );
  return [...declared, ...reExported].filter((name) => name.length > 0);
}

/**
 * The argument text of every `useState` / `useRef` call in `source`.
 *
 * Balanced-paren scanning rather than a single regular expression: an initialiser is
 * routinely a function body containing its own parentheses, and a lazy match would
 * stop at the first one and read a fragment.
 */
export function stateCellInitialisers(source: string): readonly string[] {
  const initialisers: string[] = [];
  for (const opening of source.matchAll(/\buse(?:State|Ref)\s*(?:<[^;=]*?>)?\s*\(/g)) {
    const start = opening.index + opening[0].length;
    let depth = 1;
    let cursor = start;
    while (cursor < source.length && depth > 0) {
      const character = source[cursor];
      if (character === "(") {
        depth += 1;
      } else if (character === ")") {
        depth -= 1;
      }
      cursor += 1;
    }
    initialisers.push(source.slice(start, cursor - 1));
  }
  return initialisers;
}

/** Which subject identifiers `source` captures in a state cell, or `[]`. */
export function capturedSubjectIdentifiers(source: string): readonly string[] {
  const captured = new Set<string>();
  for (const initialiser of stateCellInitialisers(source)) {
    for (const identifier of SUBJECT_IDENTIFIERS) {
      if (new RegExp(`\\b${identifier}\\b`).test(initialiser)) {
        captured.add(identifier);
      }
    }
  }
  return [...captured].sort();
}

function scannedModules(): readonly string[] {
  return SCANNED_ROOTS.flatMap((root) => {
    let entries: readonly string[];
    try {
      entries = readdirSync(join(RENDERER_SOURCE, root), { recursive: true, encoding: "utf8" });
    } catch {
      // A tree a later phase adds. Its absence is reported by the size guard below,
      // never by a silent empty scan.
      return [];
    }
    return entries
      .filter(
        (entry) =>
          (entry.endsWith(".ts") || entry.endsWith(".tsx")) &&
          !entry.endsWith(".test.ts") &&
          !entry.endsWith(".test.tsx") &&
          !entry.endsWith(".d.ts"),
      )
      .map((entry) => join(root, entry));
  }).sort();
}

function readModule(module: string): string {
  return readFileSync(join(RENDERER_SOURCE, module), "utf8");
}

describe("subject-scoped state — one holder and one latch in the whole console", () => {
  const modules = scannedModules();

  it("finds a renderer tree to scan, and finds both chokepoints in it", () => {
    // Without this, a wrong root would scan nothing and every claim below would pass
    // over the empty set.
    expect(modules.length).toBeGreaterThan(50);
    for (const chokepoint of CHOKEPOINT_MODULES) {
      expect(modules).toContain(chokepoint);
    }
  });

  it("no module outside the chokepoints exports a second implementation", () => {
    const admitted = new Set([...CHOKEPOINT_MODULES, ...CHOKEPOINT_DOORS]);
    const offenders = modules
      .filter((module) => !admitted.has(module))
      .map((module) => ({
        module,
        names: exportedSymbolNames(readModule(module)).filter((name) =>
          SECOND_IMPLEMENTATION_NAMES.test(name),
        ),
      }))
      .filter((entry) => entry.names.length > 0)
      .map((entry) => `${entry.module}: ${entry.names.join(", ")}`);
    expect(offenders).toStrictEqual([]);
  });

  it("every admitted door names a chokepoint symbol, so admission cannot launder a copy", () => {
    // Derived from the chokepoints rather than restated: a symbol renamed there
    // changes what a door has to name here, with no second list to update.
    const chokepointSymbols = CHOKEPOINT_MODULES.flatMap((chokepoint) =>
      exportedSymbolNames(readModule(chokepoint)),
    );
    expect(chokepointSymbols.length).toBeGreaterThan(0);
    for (const door of CHOKEPOINT_DOORS) {
      const doorSource = readModule(door);
      const named = chokepointSymbols.filter((symbol) =>
        new RegExp(`\\b${symbol}\\b`).test(doorSource),
      );
      expect(`${door} names ${String(named.length)} chokepoint symbols`).not.toBe(
        `${door} names 0 chokepoint symbols`,
      );
    }
  });

  it("negative control: the chokepoints themselves trip the name check", () => {
    // The tripwire matched at least one site. Without this, a typo in the expression
    // would make the clean result above meaningless.
    const matchedNames = CHOKEPOINT_MODULES.flatMap((chokepoint) =>
      exportedSymbolNames(readModule(chokepoint)).filter((name) =>
        SECOND_IMPLEMENTATION_NAMES.test(name),
      ),
    );
    expect(matchedNames).toContain("useSubjectScopedState");
    expect(matchedNames).toContain("GenerationLatch");
  });

  it("negative control: the extractor reads every export form the console writes", () => {
    expect(exportedSymbolNames("export class BridgeScopedLatch {}")).toStrictEqual([
      "BridgeScopedLatch",
    ]);
    expect(exportedSymbolNames("export function useSessionScopedState() {}")).toStrictEqual([
      "useSessionScopedState",
    ]);
    expect(exportedSymbolNames('export { MutationAttempt } from "./x.js";')).toStrictEqual([
      "MutationAttempt",
    ]);
    expect(
      exportedSymbolNames('export { Held as GoalMutationLatch } from "./x.js";'),
    ).toStrictEqual(["GoalMutationLatch"]);
    expect(exportedSymbolNames("export type { Attempt } from './x.js';")).toStrictEqual([
      "Attempt",
    ]);
    // The name check discriminates: a caller's own state type is not a second latch.
    expect(SECOND_IMPLEMENTATION_NAMES.test("MutationAttemptState")).toBe(false);
    expect(SECOND_IMPLEMENTATION_NAMES.test("AttemptGeneration")).toBe(true);
  });
});

describe("subject-scoped state — no state cell captures a subject by hand", () => {
  const modules = scannedModules();

  it("no useState or useRef initialiser names a bridge or a session id", () => {
    const admitted = new Set([
      ...CHOKEPOINT_MODULES,
      ...CHOKEPOINT_DOORS,
      ...Object.keys(ADMITTED_SUBJECT_CELLS),
    ]);
    const offenders = modules
      .filter((module) => !admitted.has(module))
      .map((module) => ({ module, captured: capturedSubjectIdentifiers(readModule(module)) }))
      .filter((entry) => entry.captured.length > 0)
      .map((entry) => `${entry.module}: ${entry.captured.join(", ")}`);
    expect(offenders).toStrictEqual([]);
  });

  it("every admitted cell still trips the checker, so no exemption outlives its cause", () => {
    // The list is the only lever this gate offers and it is the one that rots.
    // Asserting each entry still MATCHES turns a stale exemption into a red gate
    // rather than a silent hole — and doubles as proof that the scanner bites on
    // real console source, not only on the strings below.
    const inert = Object.keys(ADMITTED_SUBJECT_CELLS).filter(
      (module) => capturedSubjectIdentifiers(readModule(module)).length === 0,
    );
    expect(inert).toStrictEqual([]);
  });

  it("negative control: the scanner reads a real initialiser and bites on the shape", () => {
    // Both sides of the line the header draws, asserted against the predicate rather
    // than against whichever module happens to hold a cell today.
    expect(
      capturedSubjectIdentifiers("const [held, setHeld] = useState({ bridge, sessionId });"),
    ).toStrictEqual(["bridge", "sessionId"]);
    expect(
      capturedSubjectIdentifiers("const stamp = useRef<Stamp | undefined>(undefined);"),
    ).toStrictEqual([]);
    // A construction is not a captured subject: the class name carries the word, the
    // initialiser does not carry the value.
    expect(
      capturedSubjectIdentifiers("const [latch] = useState(() => new BridgeScopedLatch());"),
    ).toStrictEqual([]);
    // The scan is balanced: a nested call does not truncate the initialiser.
    expect(
      capturedSubjectIdentifiers("const [x] = useState(() => buildFeed(readRows(bridge)));"),
    ).toStrictEqual(["bridge"]);
    // A generic argument does not hide the initialiser behind it.
    expect(
      capturedSubjectIdentifiers("const held = useRef<Map<string, number>>(mapFor(sessionId));"),
    ).toStrictEqual(["sessionId"]);
  });
});
