// Every wire reading this console publishes goes through one scheduler.
//
// THE RULE THIS ENFORCES. `Spec-023 §Rules every console surface obeys` puts every
// read behind one scheduler and admits four reasons to take one — a surface
// arriving, the window regaining focus, a repaired connection, and a terminal event
// the owning spec names. A reading that calls the daemon straight from its open,
// with nothing that can ask it again, satisfies the letter on its first read and
// never again: it is current at mount and stale from the first reconnect, with
// nothing on screen saying so. Three of this console's readings shipped exactly that
// way — the queue list and the provider-account registry each read once when their
// stream opened and had no path back to the wire at all, and the composer's
// agent-roster read was armed once per addressing by an effect — which is why this is
// a gate and not a review note.
//
// WHAT A READING IS, mechanically. A class that BOTH publishes what a surface reads
// off it — a member named `snapshot`, `readout`, or `reading`, the three names this
// console uses for that — AND holds a `ConsoleBridge`. The conjunction is the whole
// definition: `session-store.ts` and `sidebar-model.ts` publish snapshots and hold no
// bridge, so they are not readings and this gate says nothing about them; the
// `RefreshScheduler` that `open-session-entry.ts` holds is driven by the store
// registry's own scheduling and publishes no snapshot of its own, so it is out of
// scope by the definition rather than by an exemption.
//
// AND THE THIRD NAME IS HERE BECAUSE THE GATE WAS KEYED ON A WORD. `reading` was
// missing, so `ProviderReadinessModel` — a bridge-holding class taking two one-shot
// daemon reads and publishing what they answered — was invisible to every claim
// below for no reason but what its accessor happened to be called. That is the defect
// this gate exists to catch wearing a different spelling, so the name set is the set
// of names, and the planted control at the bottom is an otherwise-identical reader
// with its accessor renamed.
//
// HOLDING IS A FIELD OR A CONSTRUCTOR PARAMETER, never a method parameter. Three
// per-bridge caches in `bridge/` expose `reading(bridge, …)` — they RESOLVE a reading
// for a bridge handed to them and hold none of their own — and counting a method
// parameter would have admitted all three as readings the moment `reading` joined the
// names above. What makes a class capable of asking the daemon on its own account is
// keeping the connection, which is spelled in a field or taken at construction.
//
// THE BRIDGE AND NOT THE CALL. Holding the bridge is what makes a class capable of
// asking the daemon, and it is spelled one way; the ASKING is spelled several — the
// approvals reader reaches the wire through the named readers in `approvals-wire.ts`
// and never writes `callDaemon` itself, so a gate keyed on the call name would have
// declared the one reading that already obeyed the rule out of scope, and the next
// reading written that way would have been invisible to it.
//
// AND WHY THE TRIGGER CONTRACT IS ASSERTED BESIDE THE SCHEDULER. A scheduler nobody
// can reach is the same defect wearing a better name, so a reading must also DECLARE
// the two members a trigger set needs — `triggeringEventKinds` and `requestRead` —
// which is what makes it wireable by `store/read-triggers.ts` rather than by four
// hand-rolled copies of the same effects. TypeScript's `implements` proves the shape
// where a class writes the clause; this proves the clause is there to write.
//
// THE CONTRACT AND NOT THE WIRING, which is why the three repos readings satisfy this
// gate without mounting a hook. A reading minted per subject inside a resource seam
// cannot call one, so `store/refresh-triggers.ts` wires the same policy imperatively
// — and it wires it by reading these same two members off the reading. Two wirings
// are honest; two vocabularies would not be, and what this gate holds is the
// vocabulary.
//
// THE CENSUS IS PINNED BY NAME. The walk can come back empty — a moved directory, a
// changed extension — and a gate over an empty set passes. Naming every reading makes
// a disappearance a failure and makes the next one arrive here first — which is what
// happened to `AgentRosterReading`, whose predecessor was a hook and so satisfied none
// of the three conjuncts this gate narrows on.

import { describe, expect, it } from "vitest";
import ts from "typescript";

import { consoleSourceModules, readConsoleSourceModule } from "../console-source-modules.js";
import { forEachDescendant, parseSourceText } from "../typescript-source.js";

/** The member names this console gives to "what a surface reads off me". */
const READING_MEMBER_NAMES: ReadonlySet<string> = new Set(["snapshot", "readout", "reading"]);

/**
 * The one class the rule speaks about that a reading OWNS rather than a surface.
 *
 * `SessionQueueSubscription` publishes a `reading` and holds the bridge, so the
 * definition above reaches it — but it is the interior of `SessionQueueReading`,
 * which is itself censused below and carries the scheduler and the trigger contract
 * on its behalf. Requiring a second scheduler here would be two schedulers for one
 * question, and the console's refresh rule puts a live subscription out of scope in
 * any case: what it publishes is kept current by its own tail, which is precisely
 * what a one-shot read has not got.
 *
 * PINNED BY NAME, on the census rule this file already follows: an exemption that
 * grew silently would be the accessor-name accident again with a list instead of a
 * word.
 */
const OWNED_INTERIOR_READINGS: ReadonlySet<string> = new Set(["SessionQueueSubscription"]);

/** The two members `ReadTriggerTarget` requires. Declared once, asserted as a pair. */
const TRIGGER_CONTRACT_MEMBERS: readonly string[] = ["triggeringEventKinds", "requestRead"];

/** The readings that exist today, by class name. The next lands here before it ships. */
const EXPECTED_READINGS: readonly string[] = [
  "AgentRosterReading",
  "ApprovalsReader",
  "ArtifactPaneReader",
  "BridgeCapabilityRead",
  "NodeProviderQuotaReading",
  "OnboardingFlow",
  "ProposalGateReader",
  "ProviderReadinessModel",
  "RepoMountsReader",
  "SessionQueueReading",
  "ShellPreferenceStore",
  "SidekickRegistryView",
];

/** One class, judged against the rule. */
interface ReadingClassCensus {
  readonly displayPath: string;
  readonly className: string;
  readonly publishesReading: boolean;
  readonly holdsBridge: boolean;
  readonly holdsScheduler: boolean;
  readonly declaresTriggerContract: boolean;
}

function memberName(member: ts.ClassElement): string | undefined {
  const { name } = member;
  if (name === undefined) {
    return undefined;
  }
  return ts.isIdentifier(name) || ts.isPrivateIdentifier(name) ? name.text : undefined;
}

/**
 * Whether this member is the thing a surface reads.
 *
 * A method, a getter, or a property holding an arrow — the three ways this console
 * writes it — and never a plain data field, which would make every object with a
 * `snapshot` field a reading.
 */
function publishesReading(member: ts.ClassElement): boolean {
  const name = memberName(member);
  if (name === undefined || !READING_MEMBER_NAMES.has(name)) {
    return false;
  }
  if (ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member)) {
    return true;
  }
  return (
    ts.isPropertyDeclaration(member) &&
    member.initializer !== undefined &&
    ts.isArrowFunction(member.initializer)
  );
}

function declaresMember(declaration: ts.ClassDeclaration, name: string): boolean {
  return declaration.members.some((member) => memberName(member) === name);
}

/**
 * Whether this class holds the daemon connection.
 *
 * Read off a declared TYPE and never off a name, so a field called something else
 * still counts and a field called `bridge` holding something else does not. A property
 * declaration and a CONSTRUCTOR parameter count — every reading here writes the first,
 * and a class taking one at construction and keeping it in a closure would still be
 * one — and a method parameter deliberately does not: a per-bridge cache resolving
 * `reading(bridge)` for a connection its caller holds is not a class that can ask the
 * daemon anything of its own.
 */
function holdsBridge(declaration: ts.ClassDeclaration): boolean {
  return declaration.members.some((member) => {
    if (ts.isPropertyDeclaration(member)) {
      return namesBridgeType(member);
    }
    return ts.isConstructorDeclaration(member) && member.parameters.some(namesBridgeType);
  });
}

/** Whether one declaration's written type is the console's bridge. */
function namesBridgeType(declaration: ts.PropertyDeclaration | ts.ParameterDeclaration): boolean {
  const { type } = declaration;
  return (
    type !== undefined &&
    ts.isTypeReferenceNode(type) &&
    ts.isIdentifier(type.typeName) &&
    type.typeName.text === "ConsoleBridge"
  );
}

function constructsNamed(node: ts.Node, constructor: string): boolean {
  let found = false;
  forEachDescendant(node, (descendant) => {
    if (
      ts.isNewExpression(descendant) &&
      ts.isIdentifier(descendant.expression) &&
      descendant.expression.text === constructor
    ) {
      found = true;
    }
  });
  return found;
}

/** Census one module's classes, from its source text alone. */
export function censusClasses(displayPath: string, source: string): readonly ReadingClassCensus[] {
  const parsed = parseSourceText(displayPath, source);
  const census: ReadingClassCensus[] = [];
  forEachDescendant(parsed, (node) => {
    if (!ts.isClassDeclaration(node) || node.name === undefined) {
      return;
    }
    census.push({
      displayPath,
      className: node.name.text,
      publishesReading: node.members.some(publishesReading),
      holdsBridge: holdsBridge(node),
      holdsScheduler: constructsNamed(node, "RefreshScheduler"),
      declaresTriggerContract: TRIGGER_CONTRACT_MEMBERS.every((member) =>
        declaresMember(node, member),
      ),
    });
  });
  return census;
}

/** The classes the rule speaks about: they publish a reading AND they hold the wire. */
function readingsIn(census: readonly ReadingClassCensus[]): readonly ReadingClassCensus[] {
  return census.filter(
    (entry) =>
      entry.publishesReading && entry.holdsBridge && !OWNED_INTERIOR_READINGS.has(entry.className),
  );
}

/**
 * The walk and the parse, done ONCE for all three claims.
 *
 * At module scope on the sibling gates' own discipline, and it is not a
 * micro-optimisation: each of the three claims below reads the same census, so
 * calling this per case parsed the whole console tree three times and took the file
 * past vitest's 5s per-case timeout whenever the tier ran beside the others — green
 * standalone and red in the suite, which is the worst way for a gate to be wrong.
 */
const CONSOLE_READINGS: readonly ReadingClassCensus[] = consoleSourceModules({}).flatMap((module) =>
  readingsIn(censusClasses(module.displayPath, readConsoleSourceModule(module))),
);

describe("every published wire reading is refreshable", () => {
  it("finds exactly the readings this console has", () => {
    const found = CONSOLE_READINGS.map((reading) => reading.className).sort();
    expect(found).toStrictEqual([...EXPECTED_READINGS].sort());
  });

  it("routes every one of them through a scheduler", () => {
    const unscheduled = CONSOLE_READINGS.filter((reading) => !reading.holdsScheduler).map(
      (reading) => `${reading.displayPath}: ${reading.className}`,
    );
    expect(unscheduled).toStrictEqual([]);
  });

  it("gives every one of them the trigger contract a trigger set needs", () => {
    const unwireable = CONSOLE_READINGS.filter((reading) => !reading.declaresTriggerContract).map(
      (reading) => `${reading.displayPath}: ${reading.className}`,
    );
    expect(unwireable).toStrictEqual([]);
  });
});

// The controls. Each is the shape the tree held before this gate, written by hand so
// the assertion above is known to fail on it rather than assumed to.
const READ_ONCE_AT_OPEN = `
class SessionQueueReading {
  readonly #bridge: ConsoleBridge;
  public snapshot = () => this.feed;
  open() {
    void callDaemon(this.#bridge, "run.queueList", {}).then((reply) => this.seat(reply));
  }
}
`;

const SCHEDULER_NOBODY_CAN_REACH = `
class NodeProviderQuotaReading {
  readonly #bridge: ConsoleBridge;
  public snapshot = () => this.readout;
  constructor() {
    this.refresh = new RefreshScheduler({ clock, perform: async () => this.read() });
  }
  read() {
    return callDaemon(this.bridge, "providerAccount.list", {});
  }
}
`;

const PUBLISHES_A_SNAPSHOT_AND_HOLDS_NO_BRIDGE = `
class SidebarModel {
  public get snapshot() {
    return this.rows;
  }
}
`;

// The same one-shot reader as `READ_ONCE_AT_OPEN`, differing in ONE thing: what its
// accessor is called. This is the shape that was invisible here — a bridge-holding
// class reading the daemon straight from its own entry point and publishing what came
// back — and it stayed invisible only because the word above it was not on a list.
const READ_ONCE_UNDER_A_DIFFERENT_ACCESSOR_NAME = `
class ProviderReadinessModel {
  readonly #bridge: ConsoleBridge;
  public get reading() {
    return this.held;
  }
  async read() {
    const reply = await callDaemon(this.#bridge, "providerAccount.list", {});
    this.held = reply;
  }
}
`;

// A per-bridge cache: it RESOLVES a reading for a connection its caller holds and
// keeps none of its own. Three of these ship in `bridge/`, and counting a method
// parameter as holding would have admitted every one of them as a reading.
const RESOLVES_A_READING_FOR_A_BRIDGE_IT_IS_HANDED = `
class SessionQueueReadings {
  readonly #bySession = new WeakMap();
  public reading(bridge: ConsoleBridge, sessionId: string) {
    return this.#bySession.get(bridge)?.get(sessionId);
  }
}
`;

describe("the gate bites", () => {
  it("catches a reading that reads once at its open", () => {
    const readings = readingsIn(censusClasses("queue-reading.ts", READ_ONCE_AT_OPEN));
    expect(readings.map((reading) => reading.className)).toStrictEqual(["SessionQueueReading"]);
    expect(readings.every((reading) => reading.holdsScheduler)).toBe(false);
  });

  it("catches a scheduler no trigger set can reach", () => {
    const readings = readingsIn(censusClasses("quota.ts", SCHEDULER_NOBODY_CAN_REACH));
    expect(readings.map((reading) => reading.className)).toStrictEqual([
      "NodeProviderQuotaReading",
    ]);
    expect(readings.every((reading) => reading.holdsScheduler)).toBe(true);
    expect(readings.every((reading) => reading.declaresTriggerContract)).toBe(false);
  });

  it("says nothing about a snapshot that holds no bridge", () => {
    expect(
      readingsIn(censusClasses("sidebar-model.ts", PUBLISHES_A_SNAPSHOT_AND_HOLDS_NO_BRIDGE)),
    ).toStrictEqual([]);
  });

  it("catches a one-shot reader whose accessor is named something else", () => {
    // The accessor-name accident, planted. Before `reading` joined the names above,
    // this class was not a reading as far as any claim here was concerned — so the
    // gate reported a clean tree over exactly the defect it was built for.
    const readings = readingsIn(
      censusClasses("provider-readiness.ts", READ_ONCE_UNDER_A_DIFFERENT_ACCESSOR_NAME),
    );
    expect(readings.map((reading) => reading.className)).toStrictEqual(["ProviderReadinessModel"]);
    expect(readings.every((reading) => reading.holdsScheduler)).toBe(false);
    expect(readings.every((reading) => reading.declaresTriggerContract)).toBe(false);
  });

  it("says nothing about a cache that resolves a reading for a bridge it is handed", () => {
    // The cost of the name above, paid on the other side: holding is a field or a
    // constructor parameter, so a `reading(bridge)` resolver is not a reading.
    expect(
      readingsIn(censusClasses("queue-feed.ts", RESOLVES_A_READING_FOR_A_BRIDGE_IT_IS_HANDED)),
    ).toStrictEqual([]);
  });
});
