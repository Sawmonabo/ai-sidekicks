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
// CONTAINS, which no type and no runtime assertion can reach. The predicates it runs
// live in `subject-state-census.ts` beside it, on the `barrel-census.ts` pattern —
// this file is the rule applied to the real tree, that one is the rule.
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
import {
  capturedSubjectIdentifiers,
  declaredSymbolNames,
  moduleSymbolNames,
  SECOND_IMPLEMENTATION_NAMES,
} from "./subject-state-census.js";

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
      // The three the two rigid hook alternatives and the anchored suffixes missed: a
      // word between the subject and the state word, and a class name carrying its
      // family term as a prefix or in the middle.
      "useBridgeKeyedState",
      "SubjectEpoch",
      "SessionGenerationCounter",
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
    // The two the four-hook scan could not see at all. Both hold a retired transport for
    // the life of the mount and neither is a `useState`, `useRef`, `useMemo`, or
    // `useReducer`.
    expect(
      capturedSubjectIdentifiers(
        "const send = useCallback(() => callDaemon(bridge, method, params), []);",
      ),
    ).toStrictEqual(["bridge"]);
    expect(
      capturedSubjectIdentifiers("useEffect(() => { subscribe(bridge, onFrame); }, []);"),
    ).toStrictEqual(["bridge"]);
  });

  it("an effect that re-runs on its subject, or on every render, is not a holder", () => {
    // The other side of the empty-list rule. Reading every effect would report the
    // ordinary shape — an effect keyed on the subject it names is the correct one — and
    // a rule that fired on it would be answered by moving the effect somewhere the scan
    // cannot see.
    expect(
      capturedSubjectIdentifiers("useEffect(() => { subscribe(bridge, onFrame); }, [bridge]);"),
    ).toStrictEqual([]);
    expect(
      capturedSubjectIdentifiers("useEffect(() => { subscribe(bridge, onFrame); });"),
    ).toStrictEqual([]);
    expect(
      capturedSubjectIdentifiers("const send = useCallback(() => read(bridge), [bridge]);"),
    ).toStrictEqual([]);
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
