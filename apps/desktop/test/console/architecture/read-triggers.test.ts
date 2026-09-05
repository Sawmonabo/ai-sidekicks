// Every wire reading this console publishes goes through one scheduler.
//
// THE RULE THIS ENFORCES. `Spec-023 §Rules every console surface obeys` puts every
// read behind one scheduler and admits four reasons to take one — a surface
// arriving, the window regaining focus, a repaired connection, and a terminal event
// the owning spec names. A reading that calls the daemon straight from its open,
// with nothing that can ask it again, satisfies the letter on its first read and
// never again: it is current at mount and stale from the first reconnect, with
// nothing on screen saying so. Two of this console's four wire readings shipped
// exactly that way — the queue list and the provider-account registry each read once
// when their stream opened and had no path back to the wire at all — which is why
// this is a gate and not a review note.
//
// WHAT A READING IS, mechanically. A class that BOTH publishes what a surface reads
// off it — a member named `snapshot` or `readout`, the two names this console uses
// for that — AND holds a `ConsoleBridge`. The conjunction is the whole definition:
// `session-store.ts` and `sidebar-model.ts` publish snapshots and hold no bridge, so
// they are not readings and this gate says nothing about them; the `RefreshScheduler`
// that `open-session-entry.ts` holds is driven by the store registry's own scheduling
// and publishes no snapshot of its own, so it is out of scope by the definition
// rather than by an exemption.
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
// THE CENSUS IS PINNED BY NAME. The walk can come back empty — a moved directory, a
// changed extension — and a gate over an empty set passes. Naming the four readings
// makes a disappearance a failure and makes a fifth one arrive here first.

import { describe, expect, it } from "vitest";
import ts from "typescript";

import { consoleSourceModules, readConsoleSourceModule } from "../console-source-modules.js";
import { forEachDescendant, parseSourceText } from "../typescript-source.js";

/** The member names this console gives to "what a surface reads off me". */
const READING_MEMBER_NAMES: ReadonlySet<string> = new Set(["snapshot", "readout"]);

/** The two members `ReadTriggerTarget` requires. Declared once, asserted as a pair. */
const TRIGGER_CONTRACT_MEMBERS: readonly string[] = ["triggeringEventKinds", "requestRead"];

/** The readings that exist today, by class name. A fifth lands here before it ships. */
const EXPECTED_READINGS: readonly string[] = [
  "ApprovalsReader",
  "BridgeCapabilityRead",
  "NodeProviderQuotaReading",
  "SessionQueueReading",
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
 * still counts and a field called `bridge` holding something else does not. Both a
 * property declaration and a constructor parameter count: the four readings write
 * the first, and a class taking one and keeping it in a closure would still be one.
 */
function holdsBridge(declaration: ts.ClassDeclaration): boolean {
  let found = false;
  forEachDescendant(declaration, (descendant) => {
    if (
      (ts.isPropertyDeclaration(descendant) || ts.isParameter(descendant)) &&
      descendant.type !== undefined &&
      ts.isTypeReferenceNode(descendant.type) &&
      ts.isIdentifier(descendant.type.typeName) &&
      descendant.type.typeName.text === "ConsoleBridge"
    ) {
      found = true;
    }
  });
  return found;
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
  return census.filter((entry) => entry.publishesReading && entry.holdsBridge);
}

function consoleReadings(): readonly ReadingClassCensus[] {
  return consoleSourceModules({}).flatMap((module) =>
    readingsIn(censusClasses(module.displayPath, readConsoleSourceModule(module))),
  );
}

describe("every published wire reading is refreshable", () => {
  it("finds exactly the readings this console has", () => {
    const found = consoleReadings()
      .map((reading) => reading.className)
      .sort();
    expect(found).toStrictEqual([...EXPECTED_READINGS].sort());
  });

  it("routes every one of them through a scheduler", () => {
    const unscheduled = consoleReadings()
      .filter((reading) => !reading.holdsScheduler)
      .map((reading) => `${reading.displayPath}: ${reading.className}`);
    expect(unscheduled).toStrictEqual([]);
  });

  it("gives every one of them the trigger contract a trigger set needs", () => {
    const unwireable = consoleReadings()
      .filter((reading) => !reading.declaresTriggerContract)
      .map((reading) => `${reading.displayPath}: ${reading.className}`);
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
});
