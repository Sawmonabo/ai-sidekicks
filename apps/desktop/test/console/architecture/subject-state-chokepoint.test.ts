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
//   1. NO SECOND IMPLEMENTATION. No module outside the chokepoints DECLARES a hook or
//      class named like one of the copies this replaced — declared, not exported,
//      because the natural shape of a seventh copy is an unexported function inside
//      the one component that needs it, and an exported-only scan cannot see it. The
//      modules admitted beside the chokepoints are DOORS, and the check enforces what
//      that word means: a door must name a symbol somebody else declared, so "door" is
//      a fact about its source rather than a promise in its header.
//   2. NO HAND-ROLLED HOLDER. No mount-lifetime state cell anywhere under the console
//      names a bridge or a session id. That is how every one of the six copies began —
//      four lines in a component that needed to remember something about the session
//      it was looking at — and it is the shape that never arrives as a deliberate
//      decision.
//
// CLAIM 2 READS FOUR HOOKS, NOT TWO, and the four are the ordinary React holders:
// `useState`, `useRef`, `useMemo`, `useReducer`. A `useMemo` with an empty dependency
// list and a `useReducer` are mount-lifetime holders with exactly the semantics of the
// first two, and a copy written with either was invisible to a scan that read only the
// first two. What separates a holder from a DERIVATION is the dependency list, so that
// is what this reads: a memo naming a bridge in its factory AND in its dependencies
// re-derives when the bridge moves, which is correct and is not flagged; one that names
// it in the factory alone is a value keyed on a subject it will never re-derive for,
// which is the defect. `useState` and `useRef` have no dependency list, so every subject
// they name is flagged.
//
// CLAIM 2 IS COARSE ON PURPOSE, and it offers NO EXEMPTION LIST. It flags a
// `useState(() => new SomethingBoundTo(bridge))` even where that something disposes
// itself correctly, and it flags a `useRef` holding a mutable handle that is never
// rendered. Both are the class this file is about — a value whose lifetime is a
// subject's kept in a cell whose lifetime is a mount's — so the only answer is to go
// through the holder. It is case-sensitive: `BridgeScopedLatch` in an initialiser is a
// construction and not a captured subject, and only the lower-case identifiers a
// component receives as props are the signature.
//
// WHAT IT DOES NOT REACH, said plainly rather than left to be discovered: a subject
// read through a local alias (`const transport = bridge` and then a cell naming
// `transport`), and a declaration nested inside a function body rather than at a
// module's top level. Both need a parser rather than a source-text scan; the claim
// here is the coarse one, and the alias is not the shape a copy is written in.
//
// THE ONE MODULE THAT IS NOT SUBJECT TO IT is `bridge/BridgeProvider.tsx`, and it is
// named a CHOKEPOINT rather than an exemption because that is what it is: it does not
// hold a value addressed by a bridge, it RESOLVES the bridge every other module is
// addressed by, from a prop that may be absent. There is no subject to key a holder
// on there — resolving one is the work. Calling that an exemption would put it in the
// same list a hand-rolled copy would be added to, so instead the check below asserts
// STRUCTURALLY that it is the only module in the tree that constructs a bridge
// resolution: a second bridge root cannot be admitted by adding a line, because there
// is no line to add.

import { describe, expect, it } from "vitest";

import {
  consoleSourceModules,
  moduleNamed,
  readConsoleSourceModule,
  type ConsoleSourceModule,
} from "../console-source-modules.js";

/**
 * The walk, done once, and shared with every other source-text gate.
 *
 * The roots this gate reads — `console/` and `shell/` — are the shared walk's own
 * default, so they are named there rather than here. This file used to carry its own
 * `readdirSync` with its own exclusion list, which admitted `.test-support.*` where
 * the shared walk excludes it: one gate scanned `fixture-bridge.test-support.ts` and
 * the timer gate beside it did not, and nothing reported the difference.
 */
const CONSOLE_MODULES: readonly ConsoleSourceModule[] = consoleSourceModules();

/** The two modules that hold the rule, written as paths so a move is reviewable. */
const CHOKEPOINT_MODULES: readonly string[] = [
  "console/store/subject-scoped-state.ts",
  "console/store/generation-latch.ts",
];

/**
 * Modules admitted to reach the vocabulary in terms of their own.
 *
 * A door holds nothing: it reaches the rule next door and either says it in another
 * family's words or wraps it in one about the RENDER that produced a value, which is
 * a question the subject-keyed holder has no view of. Admission is conditional on
 * IMPORTING a chokepoint, asserted below, so a second implementation cannot be
 * admitted by adding its path here.
 */
const CHOKEPOINT_DOORS: readonly string[] = [
  "console/seats/index.ts",
  "console/seats/session-subject.ts",
  "console/store/index.ts",
  "console/store/subject-scoped-resource.ts",
];

/**
 * The names the six replaced copies went by, as one expression.
 *
 * Two hook shapes and one suffix family. A hook pairs a SUBJECT word with either a
 * scoping word or a state word, which is what a copy is called whether or not it spells
 * every word of the one it replaced — `useSubjectState` is the same object with a word
 * dropped, and `usePaneScopedValue` is the same object at a different subject. The
 * suffixes are the class names: `Latch$`, `Register$`, and `Generation$` are anchored
 * because a state type named for one — `MutationAttemptState` — is a caller's own
 * vocabulary and not a second latch. `AttemptGeneration` is not anchored: it was a
 * whole class, and any name containing it is that class under a prefix.
 *
 * The subject words are deliberately not paired with `Store`: `useSessionStore` and
 * `useSessionStoreRegistry` are reads of a store this console already has one of, and
 * a naming rule that swept them in would be answered by renaming rather than by going
 * through the holder.
 */
const SECOND_IMPLEMENTATION_NAMES =
  /use(?:Subject|Session|Bridge|Pane|Run|Agent)(?:Scoped|Stamped)|use(?:Subject|Session|Bridge|Pane|Run|Agent)(?:State|Value|Holder)|(?:Latch|Register|Generation)$|AttemptGeneration|MutationAttempt$/;

/** What a hand-rolled holder captures: the two identities a surface is addressed by. */
const SUBJECT_IDENTIFIERS: readonly string[] = ["bridge", "sessionId"];

/** The React hooks that hold a value for the life of a mount. */
const STATE_CELL_HOOKS = /\buse(State|Ref|Memo|Reducer)\s*(?:<[^;=]*?>)?\s*\(/g;

/** Openers whose closer has to be counted before a comma can be a top-level one. */
const ARGUMENT_GROUPINGS: Readonly<Record<string, string>> = { "(": ")", "[": "]", "{": "}" };

/**
 * The one module that resolves the bridge rather than being addressed by one.
 *
 * A chokepoint on the same terms as the two above: the rule lives here, so the module
 * that holds it is not breaking it. `SUBJECT_RESOLUTION_CONSTRUCTOR` is what keeps
 * that from being a promise — the resolution class is constructed in exactly one
 * module, asserted below, so this constant admits a position in the tree and not a
 * module that put its name here.
 */
const SUBJECT_RESOLUTION_ROOT = "console/bridge/BridgeProvider.tsx";

/** The construction whose single site defines the bridge root, in source text. */
const SUBJECT_RESOLUTION_CONSTRUCTOR = "new ResolvedConsoleBridge(";

/**
 * Every name `source` DECLARES at its top level, exported or not.
 *
 * Separate from the re-export specifiers below because the two answer different
 * questions: what a module implements, and what it merely publishes. The door rule
 * rests on the first — a module that only forwards declares nothing.
 */
export function declaredSymbolNames(source: string): readonly string[] {
  return [
    ...source.matchAll(
      /^(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm,
    ),
  ]
    .map((match) => match[1] ?? "")
    .filter((name) => name.length > 0);
}

/** Every name `source` publishes from somewhere else, through an export specifier. */
export function reExportedSymbolNames(source: string): readonly string[] {
  return [...source.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}/gm)]
    .flatMap((match) =>
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
    )
    .filter((name) => name.length > 0);
}

/**
 * Every name a module either declares or publishes, which is what claim 1 scans.
 *
 * Both halves, because a copy is reachable either way: written in place, or written
 * elsewhere and re-exported into position by a barrel.
 */
export function moduleSymbolNames(source: string): readonly string[] {
  return [...declaredSymbolNames(source), ...reExportedSymbolNames(source)];
}

/** One state cell: what becomes the held value, and what would re-derive it. */
export interface StateCell {
  /** The argument texts that produce the value the cell holds. */
  readonly held: readonly string[];
  /** The argument texts that decide when it is produced again. Empty where none can. */
  readonly dependencies: readonly string[];
}

/**
 * Split one call's argument text at its top-level commas.
 *
 * Grouping-aware rather than a plain split, because every interesting argument here is
 * a function body, an object literal, or a dependency array, and each carries commas
 * of its own. A dependency list is an argument like any other, so a scan that could not
 * tell one argument from the next could not tell a holder from a derivation.
 */
export function splitTopLevelArguments(text: string): readonly string[] {
  const argumentTexts: string[] = [];
  const closers: string[] = [];
  let start = 0;
  for (let cursor = 0; cursor < text.length; cursor += 1) {
    const character = text[cursor] ?? "";
    const closer = ARGUMENT_GROUPINGS[character];
    if (closer !== undefined) {
      closers.push(closer);
    } else if (closers.length > 0 && character === closers.at(-1)) {
      closers.pop();
    } else if (character === "," && closers.length === 0) {
      argumentTexts.push(text.slice(start, cursor));
      start = cursor + 1;
    }
  }
  argumentTexts.push(text.slice(start));
  return argumentTexts.map((argumentText) => argumentText.trim()).filter((text) => text.length > 0);
}

/**
 * Every mount-lifetime state cell in `source`, split into what it holds and what
 * re-derives it.
 *
 * Balanced-paren scanning rather than a single regular expression: an initialiser is
 * routinely a function body containing its own parentheses, and a lazy match would
 * stop at the first one and read a fragment.
 *
 * Which argument holds the value is the hook's own answer and differs per hook.
 * `useState` and `useRef` take one and it is the seed. `useMemo` takes a factory and
 * then the dependencies that decide when it runs again. `useReducer` takes a reducer
 * FIRST and the initial state after it, so its held text is everything but the first
 * argument — and it has no dependency list at all, which is exactly why it is a holder.
 */
export function stateCells(source: string): readonly StateCell[] {
  const cells: StateCell[] = [];
  for (const opening of source.matchAll(STATE_CELL_HOOKS)) {
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
    const argumentTexts = splitTopLevelArguments(source.slice(start, cursor - 1));
    if (opening[1] === "Memo") {
      cells.push({ held: argumentTexts.slice(0, 1), dependencies: argumentTexts.slice(1) });
    } else if (opening[1] === "Reducer") {
      cells.push({ held: argumentTexts.slice(1), dependencies: [] });
    } else {
      cells.push({ held: argumentTexts, dependencies: [] });
    }
  }
  return cells;
}

/**
 * Which subject identifiers `source` captures in a state cell, or `[]`.
 *
 * An identifier named where the cell is PRODUCED and not where it is re-derived. A
 * memo that names the bridge in both re-derives when the bridge moves, which is the
 * correct shape and the one the palette's command list is written in; a cell that
 * names it only in the first is a value keyed on a subject it will never be produced
 * for again.
 */
export function capturedSubjectIdentifiers(source: string): readonly string[] {
  const captured = new Set<string>();
  for (const cell of stateCells(source)) {
    for (const identifier of SUBJECT_IDENTIFIERS) {
      const named = new RegExp(`\\b${identifier}\\b`);
      if (
        cell.held.some((text) => named.test(text)) &&
        !cell.dependencies.some((text) => named.test(text))
      ) {
        captured.add(identifier);
      }
    }
  }
  return [...captured].sort();
}

function scannedModules(): readonly string[] {
  return CONSOLE_MODULES.map((module) => module.displayPath);
}

function readModule(module: string): string {
  return readConsoleSourceModule(moduleNamed(CONSOLE_MODULES, module));
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
        names: moduleSymbolNames(readModule(module)).filter((name) =>
          SECOND_IMPLEMENTATION_NAMES.test(name),
        ),
      }))
      .filter((entry) => entry.names.length > 0)
      .map((entry) => `${entry.module}: ${entry.names.join(", ")}`);
    expect(offenders).toStrictEqual([]);
  });

  it("every admitted door names a symbol it did not declare, so admission cannot launder a copy", () => {
    // Derived from the sources rather than restated: a symbol renamed in a chokepoint
    // changes what a door has to name here, with no second list to update.
    //
    // A family barrel publishes the door beside it rather than the chokepoint two
    // families down, so the set a door may draw from is the chokepoints' declarations
    // plus the OTHER admitted doors'. Its own are excluded, and that exclusion is the
    // guard: a copy added to the list above would have to name something somebody else
    // wrote, and a copy names only itself.
    const chokepointSymbols = CHOKEPOINT_MODULES.flatMap((chokepoint) =>
      declaredSymbolNames(readModule(chokepoint)),
    );
    expect(chokepointSymbols.length).toBeGreaterThan(0);
    for (const door of CHOKEPOINT_DOORS) {
      const reachable = [
        ...chokepointSymbols,
        ...CHOKEPOINT_DOORS.filter((other) => other !== door).flatMap((other) =>
          declaredSymbolNames(readModule(other)),
        ),
      ];
      const doorSource = readModule(door);
      const named = reachable.filter((symbol) => new RegExp(`\\b${symbol}\\b`).test(doorSource));
      expect(`${door} names ${String(named.length)} symbols it did not declare`).not.toBe(
        `${door} names 0 symbols it did not declare`,
      );
    }
  });

  it("negative control: the chokepoints themselves trip the name check", () => {
    // The tripwire matched at least one site. Without this, a typo in the expression
    // would make the clean result above meaningless.
    const matchedNames = CHOKEPOINT_MODULES.flatMap((chokepoint) =>
      moduleSymbolNames(readModule(chokepoint)).filter((name) =>
        SECOND_IMPLEMENTATION_NAMES.test(name),
      ),
    );
    expect(matchedNames).toContain("useSubjectScopedState");
    expect(matchedNames).toContain("GenerationLatch");
  });

  it("negative control: the extractor reads every declaration and export form", () => {
    expect(moduleSymbolNames("export class BridgeScopedLatch {}")).toStrictEqual([
      "BridgeScopedLatch",
    ]);
    expect(moduleSymbolNames("export function useSessionScopedState() {}")).toStrictEqual([
      "useSessionScopedState",
    ]);
    expect(moduleSymbolNames('export { MutationAttempt } from "./x.js";')).toStrictEqual([
      "MutationAttempt",
    ]);
    expect(moduleSymbolNames('export { Held as GoalMutationLatch } from "./x.js";')).toStrictEqual([
      "GoalMutationLatch",
    ]);
    expect(moduleSymbolNames("export type { Attempt } from './x.js';")).toStrictEqual(["Attempt"]);
    // A copy is written where it is needed, and the natural shape of that is a
    // module-local function nothing exports. An exported-only scan could not see it.
    expect(moduleSymbolNames("function useSessionScoped() {}")).toStrictEqual(["useSessionScoped"]);
    expect(moduleSymbolNames("class GenerationRegister {}")).toStrictEqual(["GenerationRegister"]);
  });

  it("planted violation: every shape a seventh copy would be named trips the check", () => {
    // Each of these passed the expression this replaced, and each is one word away
    // from a name that did not. Without them the clean result above would be a claim
    // about the six spellings already in the tree rather than about the class.
    for (const planted of [
      "useSubjectScopedState",
      "useSubjectState",
      "usePaneScopedValue",
      "useSessionScoped",
      "useRunHolder",
      "GenerationRegister",
      "GoalMutationLatch",
      "AttemptGeneration",
      "SendAttemptGeneration",
      "MutationAttempt",
    ]) {
      expect(SECOND_IMPLEMENTATION_NAMES.test(planted), `${planted} slipped past`).toBe(true);
    }
    // And the names it must NOT take, because each is a read of something the console
    // has exactly one of and a rule that swept them in would be answered by renaming.
    for (const admitted of [
      "MutationAttemptState",
      "useSessionStore",
      "useOpenSessionStore",
      "useSessionStoreRegistry",
      "useSessionInitialised",
      "ConsoleEntityProjectorRegistry",
    ]) {
      expect(SECOND_IMPLEMENTATION_NAMES.test(admitted), `${admitted} was flagged`).toBe(false);
    }
  });
});

describe("subject-scoped state — no state cell captures a subject by hand", () => {
  const modules = scannedModules();

  it("no mount-lifetime state cell holds a bridge or a session id by hand", () => {
    const admitted = new Set([...CHOKEPOINT_MODULES, ...CHOKEPOINT_DOORS, SUBJECT_RESOLUTION_ROOT]);
    const offenders = modules
      .filter((module) => !admitted.has(module))
      .map((module) => ({ module, captured: capturedSubjectIdentifiers(readModule(module)) }))
      .filter((entry) => entry.captured.length > 0)
      .map((entry) => `${entry.module}: ${entry.captured.join(", ")}`);
    expect(offenders).toStrictEqual([]);
  });

  it("the bridge root is the only module that constructs a bridge resolution", () => {
    // What makes the one unchecked module a chokepoint rather than an exemption. A
    // second module resolving a bridge would be a second answer to which bridge a
    // window renders against, and it would be invisible to claim 2 the moment
    // someone added its path beside this constant — so the position is asserted from
    // the source instead: exactly one module constructs the resolution, and it is
    // this one.
    const constructors = modules.filter((module) =>
      readModule(module).includes(SUBJECT_RESOLUTION_CONSTRUCTOR),
    );
    expect(constructors).toStrictEqual([SUBJECT_RESOLUTION_ROOT]);
  });

  it("the bridge root still trips the checker, so the constant cannot outlive its cause", () => {
    // The constant is the only position this gate leaves unchecked, and it is the one
    // that rots. Asserting it still MATCHES turns a stale admission into a red gate
    // rather than a silent hole — and doubles as proof that the scanner bites on real
    // console source, not only on the strings below.
    expect(capturedSubjectIdentifiers(readModule(SUBJECT_RESOLUTION_ROOT))).not.toStrictEqual([]);
  });

  it("the two window-lifetime resources go through the holder rather than around it", () => {
    // These two held a window's registry and its database connection in a `useState`
    // initialiser keyed on nothing, so a replaced bridge left both bound to a retired
    // transport. They were the gate's last two admissions; asserting the shape they
    // moved to is what stops the fix being reverted into a fresh admission.
    //
    // The RESOURCE form specifically, and not the plain holder: both own something a
    // drop does not release — a registry with its binder, an open database connection
    // — and seeding runs during a render React may throw away, so the pass that
    // opened one is not necessarily a pass anything will ever clean up after.
    for (const module of [
      "console/frame/session-lifecycle.ts",
      "console/frame/ui-state-lifecycle.ts",
    ]) {
      const source = readModule(module);
      expect(source, `${module} no longer holds its resource through the holder`).toContain(
        "useSubjectScopedResource",
      );
      expect(
        capturedSubjectIdentifiers(source),
        `${module} captures a subject by hand`,
      ).toStrictEqual([]);
    }
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

  it("planted violation: the two other mount-lifetime holders trip the scan too", () => {
    // Both passed the two-hook scan this replaced. A memo with an empty dependency
    // list holds for the life of the mount exactly as a `useState` initialiser does,
    // and a reducer has no dependency list at all.
    expect(
      capturedSubjectIdentifiers("const holder = useMemo(() => new Holder(bridge), []);"),
    ).toStrictEqual(["bridge"]);
    expect(
      capturedSubjectIdentifiers("const [state, dispatch] = useReducer(reduceRows, sessionId);"),
    ).toStrictEqual(["sessionId"]);
    expect(
      capturedSubjectIdentifiers(
        "const models = useMemo(() => modelsFor(sessionId), [somethingElse]);",
      ),
    ).toStrictEqual(["sessionId"]);
  });

  it("a derivation that re-derives on its subject is not a holder and is not flagged", () => {
    // The other side of the same line, and the reason the scan reads the dependency
    // list rather than the whole call. A memo naming the bridge in both places is
    // rebuilt when the bridge moves, which is the shape the palette's command list is
    // written in — flagging it would be answered by writing the derivation somewhere
    // the scan cannot see.
    expect(
      capturedSubjectIdentifiers(
        "const commands = useMemo(() => buildCommands(bridge, onRefusal), [bridge, onRefusal]);",
      ),
    ).toStrictEqual([]);
    // And the split is grouping-aware: the commas inside the factory belong to it.
    expect(
      capturedSubjectIdentifiers(
        "const rows = useMemo(() => ({ a: read(bridge, sessionId), b: 1 }), [bridge, sessionId]);",
      ),
    ).toStrictEqual([]);
    // The reducer's FIRST argument is the reducer, not the held value.
    expect(
      capturedSubjectIdentifiers("const [state] = useReducer(reduceBridgeRows, EMPTY);"),
    ).toStrictEqual([]);
  });
});
