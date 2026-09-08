// A repos call is a read or an act, and a read is made inside a round — asserted
// against the source rather than against the comment that claims it.
//
// TWO CLAIMS, ONE SUBJECT. `console/repos/repo-reads.ts` opens by saying that its reads
// take an abort signal and its acts deliberately do not, and that the requirement is
// what makes "a read here cannot be made outside a round" structural rather than a
// convention a call site follows. `store/act-controller-base.ts` says the same thing one
// layer up, about the prerequisite question every act controller reads before it acts.
// Both sentences were false when they were written: two wrappers took no signal, and the
// controller that reads through them dropped the round its own scheduler handed it.
//
// THE READS ARE DERIVED AND NOT LISTED, which is the difference between a gate that
// keeps holding and a roster that goes stale the first time a wrapper is added. The
// classifier is the wire's own naming: a registered method that reads answers a
// `…ReadResponse`, a `…ListResponse`, or a `…CheckResponse`, and a method that records
// answers something else — `…SelectResponse`, `…AttachResponse`, `…BindResponse`,
// `…PrepareResponse`, `…RetireResponse`, `…DisposeResponse`. That partition comes out of
// the contracts package rather than out of this file, so a seventh read added tomorrow
// is classified by the type it returns and is held to the claim without anybody
// remembering to name it here. The floors below are what keep the derivation from
// quietly reporting on nothing.
//
// AND THE THREE VERBS THEMSELVES ARE NOT DECLARED HERE. They were, as a suffix list,
// while `daemon-read-signal-census.ts` held the same closed set spelled as words — so a
// fourth reading verb landing in the contracts moved whichever list its author
// remembered and left the other gate reading that verb as a mutation. That census
// classifies by no name at all now, the console declaring its own method partition, so
// `daemon-reading-verbs.ts` has exactly one derivation left and it is this one; the
// control below widens the set and watches this classifier move with it.
//
// AND THE CONTROLLER CLAIM IS DERIVED THE SAME WAY: every module that extends the act
// controller base is found by its `extends` clause, and each is held to declaring the
// signal AND using it. Declaring one and ignoring it is the failure this gate is really
// about — it compiles, it renders, and it stops nothing.
//
// THE HONEST LIMIT, the one every source-text tripwire has. This reads text, so a
// wrapper that reached its signal through a value it was handed, or an override that
// forwarded one under another name, is invisible here. The runtime counterparts exist
// and are where those would be caught: `repos/repo-reads.signal.test.ts` drives both
// wrappers through the real door with an abandoned round, and
// `store/act-controller.read-round.test.ts` drives the machine's own disposal.
//
// Test files are excluded by the shared source walk, which is load-bearing here: this
// file writes every forbidden form below as a planted control.

import { describe, expect, it } from "vitest";

import {
  consoleSourceModules,
  readConsoleSourceModule,
  readModuleNamed,
  type ConsoleSourceModule,
} from "../console-source-modules.js";
import { READING_VERBS, answersReadingResponse } from "./daemon-reading-verbs.js";

/** The repos family's one module of `repo.*` call wrappers. */
const REPO_READS_MODULE = "console/repos/repo-reads.ts";

/** The base class every act controller composes its machine through. */
const ACT_CONTROLLER_BASE_MODULE = "console/store/act/act-controller-base.ts";

/** The machine that performs a prerequisite read. */
const ACT_CONTROLLER_MODULE = "console/store/act/act-controller.ts";

/** How a subclass declares itself one. The needle the controller census derives from. */
const ACT_CONTROLLER_EXTENDS_FORM = "extends ActSurfaceController<";

/** One `callDaemon` wrapper, as its source text describes it. */
interface CallWrapper {
  readonly name: string;
  /** The `X` in `Promise<DaemonReply<X>>`, or `""` where the shape did not match. */
  readonly responseType: string;
  readonly declaresSignal: boolean;
  readonly forwardsSignal: boolean;
  readonly namesSignal: boolean;
}

/**
 * `source` with its line comments removed.
 *
 * Prose is where the word `signal` appears without a signal being touched, and a
 * predicate that counted it would report a controller as compliant for explaining why
 * it is not. The stripping is line-scoped, which is all these bodies need and all a
 * text tripwire can honestly claim.
 */
function withoutLineComments(source: string): string {
  return source
    .split("\n")
    .map((line) => {
      const comment = line.indexOf("//");
      return comment === -1 ? line : line.slice(0, comment);
    })
    .join("\n");
}

/**
 * Every exported async wrapper in `source` that calls the door, in declaration order.
 *
 * A pure function over text so the controls below drive it with sources whose verdict
 * is known, and the checker is proved to bite without perturbing a module.
 */
function callWrappers(source: string): readonly CallWrapper[] {
  const marker = "export async function ";
  const wrappers: CallWrapper[] = [];
  const starts: number[] = [];
  for (let at = source.indexOf(marker); at !== -1; at = source.indexOf(marker, at + 1)) {
    starts.push(at);
  }
  for (const [index, start] of starts.entries()) {
    const chunk = withoutLineComments(source.slice(start, starts[index + 1] ?? source.length));
    if (!chunk.includes("callDaemon(")) {
      continue;
    }
    const name = /export async function ([A-Za-z0-9_]+)/.exec(chunk)?.[1] ?? "";
    wrappers.push({
      name,
      responseType: /Promise<DaemonReply<([A-Za-z0-9_]+)>>/.exec(chunk)?.[1] ?? "",
      declaresSignal: /\bsignal: AbortSignal\b/.test(chunk),
      forwardsSignal: chunk.includes("{ signal }"),
      namesSignal: /\bsignal\b/.test(chunk),
    });
  }
  return wrappers;
}

/**
 * Whether this wrapper's declared response type is a reading's.
 *
 * Not a list of functions: a question about the shape a reading method answers with.
 * Every `repo.*` read in the registry answers one of the three verbs' response types
 * and no recording method answers any of them, which is what makes the classifier
 * total over the module — and the verbs come from their own home rather than from a
 * list written here, so the control below can widen the set and watch this move.
 */
function isReadWrapper(wrapper: CallWrapper): boolean {
  return answersReadingResponse(wrapper.responseType);
}

/** The `readPrerequisite` override's own text, or `""` where the module has none. */
function prerequisiteOverride(source: string): string {
  const start = source.indexOf("readPrerequisite(");
  if (start === -1) {
    return "";
  }
  const body = source.slice(start);
  const end = body.indexOf("\n  }");
  return withoutLineComments(end === -1 ? body : body.slice(0, end));
}

/** How many times `methodText` names a signal. One is the declaration; two is a use. */
function signalMentions(methodText: string): number {
  return methodText.match(/\bsignal\b/g)?.length ?? 0;
}

describe("repos call wrappers — every read takes a signal, every act takes none", () => {
  const source = (): string =>
    readModuleNamed(consoleSourceModules(), REPO_READS_MODULE, "the repos call wrappers");
  const wrappers = (): readonly CallWrapper[] => callWrappers(source());

  it("finds both halves of the module to hold to the claim", () => {
    // The derivation's floor, twice over. A predicate matching nothing — or matching
    // only one side — would make the assertions below vacuously true, which is the
    // failure mode a derived set has and a hand-written roster does not.
    const found = wrappers();
    const reads = found.filter(isReadWrapper);
    expect(reads.length).toBeGreaterThanOrEqual(6);
    expect(found.length - reads.length).toBeGreaterThanOrEqual(6);
    expect(found.every((wrapper) => wrapper.responseType !== "")).toBe(true);
  });

  it("classifies the two wrappers that used to be made outside a round as reads", () => {
    // Named because they are the regression: both are SECOND wrappers over a subject a
    // first wrapper already read with a signal, which is the shape the claim is
    // easiest to break in. Asserted through the classifier rather than beside it.
    const byName = new Map(wrappers().map((wrapper) => [wrapper.name, wrapper]));
    const mountArm = byName.get("readMountExecutionModeCapabilities");
    const reuseCheck = byName.get("checkWorktreeReuse");
    expect(mountArm).toBeDefined();
    expect(reuseCheck).toBeDefined();
    expect(mountArm !== undefined && isReadWrapper(mountArm)).toBe(true);
    expect(reuseCheck !== undefined && isReadWrapper(reuseCheck)).toBe(true);
  });

  it("every read declares a required signal and forwards it to the door", () => {
    const offenders = wrappers()
      .filter(isReadWrapper)
      .filter((wrapper) => !wrapper.declaresSignal || !wrapper.forwardsSignal)
      .map((wrapper) => wrapper.name);
    expect(offenders).toStrictEqual([]);
  });

  it("no act names a signal at all", () => {
    // The other half of the module's stated rule, and the one that would rot silently:
    // an act that reached the daemon has HAPPENED, so abandoning the console's half of
    // it would leave a person reading a surface that says it did not occur.
    const offenders = wrappers()
      .filter((wrapper) => !isReadWrapper(wrapper))
      .filter((wrapper) => wrapper.namesSignal)
      .map((wrapper) => wrapper.name);
    expect(offenders).toStrictEqual([]);
  });

  it("negative control: a read added without a signal would be caught", () => {
    // Written as the change that would defeat the claim — which is the change this
    // gate exists because somebody already made, twice.
    const planted = [
      "export async function readSomethingNew(",
      "  bridge: ConsoleBridge,",
      "  repoMountId: RepoMountId,",
      "): Promise<DaemonReply<SomethingNewReadResponse>> {",
      '  return callDaemon(bridge, "repo.somethingNew", { repoMountId });',
      "}",
    ].join("\n");
    const [wrapper] = callWrappers(planted);
    expect(wrapper).toBeDefined();
    expect(wrapper !== undefined && isReadWrapper(wrapper)).toBe(true);
    expect(wrapper?.declaresSignal).toBe(false);
    expect(wrapper?.forwardsSignal).toBe(false);
  });

  it("negative control: an act handed a signal would be caught", () => {
    const planted = [
      "export async function recordSomething(",
      "  bridge: ConsoleBridge,",
      "  worktreeId: WorktreeId,",
      "  signal: AbortSignal,",
      "): Promise<DaemonReply<WorktreeRetireResponse>> {",
      '  return callDaemon(bridge, "repo.worktreeRetire", { worktreeId }, { signal });',
      "}",
    ].join("\n");
    const [wrapper] = callWrappers(planted);
    expect(wrapper !== undefined && isReadWrapper(wrapper)).toBe(false);
    expect(wrapper?.namesSignal).toBe(true);
  });

  it("negative control: the classifier reads the return type and not the name", () => {
    // A wrapper named `read…` that records, and one named otherwise that reads. The
    // partition has to survive both, or it is a naming convention wearing a gate's
    // clothes.
    const planted = [
      "export async function readyTheClone(",
      "): Promise<DaemonReply<EphemeralClonePrepareResponse>> {",
      '  return callDaemon(bridge, "repo.ephemeralClonePrepare", request);',
      "}",
      "export async function probeStatus(",
      "  signal: AbortSignal,",
      "): Promise<DaemonReply<WorktreeStatusReadResponse>> {",
      '  return callDaemon(bridge, "repo.worktreeStatusRead", request, { signal });',
      "}",
    ].join("\n");
    const found = callWrappers(planted);
    expect(found.map((wrapper) => isReadWrapper(wrapper))).toStrictEqual([false, true]);
  });

  it("negative control: the verb set is closed, and widening it moves this classifier", () => {
    // THE CLOSED SET, PROVED CLOSED. `daemon-reading-verbs.ts` declares the three verbs
    // this gate partitions on, and the `verbs` parameter exists so a control can widen
    // the set and watch the answer move — which is the only way to show that the
    // classification really is read off that declaration rather than off a list this
    // file happens to agree with. A fourth verb landing in the contracts is a
    // deliberate edit there, and this is what makes that edit's effect visible.
    expect(answersReadingResponse("WorkspaceProbeResponse")).toBe(false);
    const widened = [...READING_VERBS, "Probe"];
    expect(answersReadingResponse("WorkspaceProbeResponse", widened)).toBe(true);
    // And the widening is real rather than a rule that admits everything.
    expect(answersReadingResponse("EphemeralCloneDisposeResponse", widened)).toBe(false);
  });

  it("negative control: a declaration that never calls the door is not a wrapper", () => {
    // The census counts dispatchers, not everything exported: a helper that narrows an
    // identifier has no signal to take and must not be reported as a read missing one.
    expect(
      callWrappers(
        ["export async function describeSomething(): Promise<string> {", '  return "x";', "}"].join(
          "\n",
        ),
      ),
    ).toStrictEqual([]);
  });
});

describe("act controllers — the prerequisite is read inside the round it is handed", () => {
  const modules: readonly ConsoleSourceModule[] = consoleSourceModules();
  const subclasses = modules.filter((module) =>
    readConsoleSourceModule(module).includes(ACT_CONTROLLER_EXTENDS_FORM),
  );

  it("finds the controllers to hold to the claim", () => {
    // The floor. Three subclasses exist — attach, bind, and execution-root prepare —
    // and a predicate that found none would make every assertion below vacuous.
    expect(subclasses.length).toBeGreaterThanOrEqual(3);
  });

  it("the base requires the signal, so a subclass cannot be written without one", () => {
    // The structural half: the override's contract is where this is enforced for every
    // controller at once, rather than at three call sites that could each forget.
    const base = readModuleNamed(modules, ACT_CONTROLLER_BASE_MODULE, "the act controller base");
    const abstractDeclaration = base.slice(base.indexOf("protected abstract readPrerequisite("));
    expect(abstractDeclaration).not.toBe("");
    expect(abstractDeclaration.slice(0, abstractDeclaration.indexOf(">;"))).toContain(
      "signal: AbortSignal,",
    );
  });

  it("the machine rides its scheduler's round and holds no second register beside it", () => {
    // A round is a latch claim and a signal as ONE value, so a key taken beside it
    // would be two registers answering one question — and the one this class used to
    // take could order a settlement it had no way to stop.
    const machine = readModuleNamed(modules, ACT_CONTROLLER_MODULE, "the act controller machine");
    expect(machine).toContain("perform: async (_reasons, round) => {");
    expect(machine).toContain("this.#readPrerequisite(question, round.signal)");
    expect(machine).toContain("round.settle(");
    expect(machine).not.toContain("PREREQUISITE_KEY");
  });

  it("every controller declares the signal and uses it", () => {
    // DECLARING ONE AND IGNORING IT IS THE FAILURE THIS IS ABOUT. It compiles, it
    // renders, and it stops nothing — so the claim is two mentions in the override's
    // own code: the parameter, and whatever it is handed to.
    const offenders = subclasses
      .map((module) => ({
        module: module.displayPath,
        override: prerequisiteOverride(readConsoleSourceModule(module)),
      }))
      .filter(({ override }) => signalMentions(override) < 2)
      .map(({ module }) => module);
    expect(offenders).toStrictEqual([]);
  });

  it("negative control: an override that declares the signal and drops it is caught", () => {
    const planted = [
      "  protected override async readPrerequisite(",
      "    _question: string,",
      "    signal: AbortSignal,",
      "  ): Promise<ActOutcome<Capabilities>> {",
      "    return await readCapabilities(this.#bridge, this.#repoMountId);",
      "  }",
    ].join("\n");
    expect(signalMentions(prerequisiteOverride(planted))).toBe(1);
  });

  it("negative control: an override that names no signal at all is caught", () => {
    const planted = [
      "  protected override async readPrerequisite(): Promise<ActOutcome<Capabilities>> {",
      "    return await readCapabilities(this.#bridge, this.#repoMountId);",
      "  }",
    ].join("\n");
    expect(signalMentions(prerequisiteOverride(planted))).toBe(0);
  });

  it("negative control: the predicate reads code and not prose", () => {
    // The word appears in every one of these doc comments, so a counter that read them
    // would report a controller as compliant for explaining why it is not.
    const planted = [
      "  protected override async readPrerequisite(",
      "    _question: string,",
      "    signal: AbortSignal,",
      "  ): Promise<ActOutcome<Capabilities>> {",
      "    // The signal reaches the door, and the signal is what stops the read.",
      "    return await readCapabilities(this.#bridge, this.#repoMountId);",
      "  }",
    ].join("\n");
    expect(signalMentions(prerequisiteOverride(planted))).toBe(1);
  });

  it("negative control: an override that forwards it counts as a use", () => {
    // The clean side of the same line, so the predicate is proved to admit as well as
    // to refuse.
    const planted = [
      "  protected override async readPrerequisite(",
      "    _question: string,",
      "    signal: AbortSignal,",
      "  ): Promise<ActOutcome<Capabilities>> {",
      "    return await readCapabilities(this.#bridge, this.#repoMountId, signal);",
      "  }",
    ].join("\n");
    expect(signalMentions(prerequisiteOverride(planted))).toBe(2);
  });
});
