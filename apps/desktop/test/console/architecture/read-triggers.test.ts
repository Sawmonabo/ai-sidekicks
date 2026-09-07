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
// HOW A CLASS IS READ IS `reading-census.ts`'S, beside this file on the tier's own
// census/claims split: every name this gate keys on is BOUND to the module it came
// from rather than matched as text, and a class is read together with every base its
// `extends` chain binds, bounded at four hops. Both rules are stated there, where the
// walk that applies them lives; what stays here is the rule they serve, the census pin,
// and the controls that prove each half fails on the shape it is written against.
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

import { consoleSourceModules, readConsoleSourceModule } from "../console-source-modules.js";
import {
  censusClasses,
  readingsIn,
  withInheritance,
  type ConsoleModuleText,
  type ReadingClassCensus,
} from "./reading-census.js";

/** The readings that exist today, by class name. The next lands here before it ships. */
const EXPECTED_READINGS: readonly string[] = [
  "AgentRosterReading",
  "ApprovalsReader",
  "ArtifactPaneReader",
  "AttachController",
  "BindWorkspaceController",
  "BridgeCapabilityRead",
  "ExecutionRootPrepareController",
  "NodeProviderQuotaReading",
  "ProposalGateReader",
  "RepoMountsReader",
  "SessionQueueReading",
  "ShellPreferenceStore",
  "SidekickRegistryView",
  "WorkspaceExecutionContextReader",
];

/**
 * The walk and the parse, done ONCE for all three claims.
 *
 * At module scope on the sibling gates' own discipline, and it is not a
 * micro-optimisation: each of the three claims below reads the same census, so
 * calling this per case parsed the whole console tree three times and took the file
 * past vitest's 5s per-case timeout whenever the tier ran beside the others — green
 * standalone and red in the suite, which is the worst way for a gate to be wrong.
 */
const CONSOLE_MODULE_TEXTS: readonly ConsoleModuleText[] = consoleSourceModules({}).map(
  (module) => ({ displayPath: module.displayPath, source: readConsoleSourceModule(module) }),
);

/**
 * The same modules, keyed the way an import specifier resolves.
 *
 * The extension is dropped because a specifier names `.js` for a `.ts` module and
 * `.js` for a `.tsx` one, and the walk should not have to guess which.
 */
const CONSOLE_MODULE_INDEX: ReadonlyMap<string, ConsoleModuleText> = new Map(
  CONSOLE_MODULE_TEXTS.map((entry) => [entry.displayPath.replace(/\.(?:ts|tsx)$/u, ""), entry]),
);

const CONSOLE_READINGS: readonly ReadingClassCensus[] = CONSOLE_MODULE_TEXTS.flatMap((entry) =>
  readingsIn(
    censusClasses(entry.displayPath, entry.source).map((census) =>
      withInheritance(census, CONSOLE_MODULE_INDEX),
    ),
  ),
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
// the assertion above is known to fail on it rather than assumed to. Each fixture
// carries its own imports, because every predicate here is a binding: a fixture that
// merely SPELLED `ConsoleBridge` would prove nothing about a gate that resolves it.
const READ_ONCE_AT_OPEN = `
import type { ConsoleBridge } from "../bridge/index.js";
class SessionQueueReading {
  readonly #bridge: ConsoleBridge;
  public snapshot = () => this.feed;
  open() {
    void callDaemon(this.#bridge, "run.queueList", {}).then((reply) => this.seat(reply));
  }
}
`;

const SCHEDULER_NOBODY_CAN_REACH = `
import type { ConsoleBridge } from "../bridge/index.js";
import { RefreshScheduler } from "../store/index.js";
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

// A reading that holds the real bridge and constructs a class it declared ITSELF and
// happened to name `ActController`. Under a name-only match this passed the scheduler
// assertion while holding no scheduler at all.
const SCHEDULER_IN_NAME_ONLY = `
import type { ConsoleBridge } from "../bridge/index.js";
class ActController {
  request() {}
}
class SessionQueueReading {
  readonly #bridge: ConsoleBridge;
  public get snapshot() {
    return this.feed;
  }
  public readonly triggeringEventKinds = new Set();
  public requestRead() {}
  constructor() {
    this.acts = new ActController();
  }
}
`;

// The two halves of the inheritance fold, as a module pair: a base that holds the
// scheduler and declares the pass-throughs, and a subclass that holds the bridge and
// declares neither. Read apart, the subclass is not a reading and the base is not one
// either, so the rule would speak about nothing.
const ACT_BASE_MODULE = `
import { ActController } from "./act-controller.js";
export abstract class ActSurfaceController {
  public readonly triggeringEventKinds;
  readonly #acts;
  constructor(options) {
    this.#acts = new ActController(options);
  }
  public get snapshot() {
    return this.#acts.snapshot;
  }
  public requestRead(reason) {
    this.#acts.requestRead(reason);
  }
}
`;

const ACT_BASE_DOOR = `
export { ActSurfaceController } from "./act-controller-base.js";
`;

const SUBCLASS_OF_THE_BASE = `
import type { ConsoleBridge } from "../bridge/index.js";
import { ActSurfaceController } from "../store/index.js";
export class AttachController extends ActSurfaceController {
  readonly #bridge: ConsoleBridge;
  public async attach() {}
}
`;

/** The fixture pair, indexed the way the real walk indexes the tree. */
const PLANTED_INDEX: ReadonlyMap<string, ConsoleModuleText> = new Map([
  [
    "console/store/act-controller-base",
    { displayPath: "console/store/act-controller-base.ts", source: ACT_BASE_MODULE },
  ],
  ["console/store/index", { displayPath: "console/store/index.ts", source: ACT_BASE_DOOR }],
]);

describe("the gate bites", () => {
  it("catches a reading that reads once at its open", () => {
    const readings = readingsIn(
      censusClasses("console/ledger/queue-reading.ts", READ_ONCE_AT_OPEN),
    );
    expect(readings.map((reading) => reading.className)).toStrictEqual(["SessionQueueReading"]);
    expect(readings.every((reading) => reading.holdsScheduler)).toBe(false);
  });

  it("catches a scheduler no trigger set can reach", () => {
    const readings = readingsIn(
      censusClasses("console/ledger/quota.ts", SCHEDULER_NOBODY_CAN_REACH),
    );
    expect(readings.map((reading) => reading.className)).toStrictEqual([
      "NodeProviderQuotaReading",
    ]);
    expect(readings.every((reading) => reading.holdsScheduler)).toBe(true);
    expect(readings.every((reading) => reading.declaresTriggerContract)).toBe(false);
  });

  it("says nothing about a snapshot that holds no bridge", () => {
    expect(
      readingsIn(
        censusClasses("console/ledger/sidebar-model.ts", PUBLISHES_A_SNAPSHOT_AND_HOLDS_NO_BRIDGE),
      ),
    ).toStrictEqual([]);
  });

  it("catches a local class that is a scheduler holder in name only", () => {
    const readings = readingsIn(
      censusClasses("console/ledger/queue-reading.ts", SCHEDULER_IN_NAME_ONLY),
    );
    expect(readings.map((reading) => reading.className)).toStrictEqual(["SessionQueueReading"]);
    expect(readings.every((reading) => reading.declaresTriggerContract)).toBe(true);
    expect(readings.every((reading) => reading.holdsScheduler)).toBe(false);
  });

  it("reads a subclass together with the base its extends clause binds", () => {
    const [subclass] = censusClasses("console/repos/attach-controller.ts", SUBCLASS_OF_THE_BASE);
    expect(subclass).toBeDefined();
    // Read alone, the subclass declares none of the three conjuncts but the bridge.
    expect(subclass?.publishesReading).toBe(false);
    expect(subclass?.holdsScheduler).toBe(false);
    expect(subclass?.declaresTriggerContract).toBe(false);
    expect(subclass?.holdsBridge).toBe(true);
    const folded = withInheritance(subclass!, PLANTED_INDEX);
    expect(folded.publishesReading).toBe(true);
    expect(folded.holdsScheduler).toBe(true);
    expect(folded.declaresTriggerContract).toBe(true);
  });

  it("negative control: a base reached by name rather than by import is not followed", () => {
    const withoutTheImport = SUBCLASS_OF_THE_BASE.replace(
      'import { ActSurfaceController } from "../store/index.js";\n',
      "",
    );
    const [subclass] = censusClasses("console/repos/attach-controller.ts", withoutTheImport);
    expect(subclass?.baseModule).toBeUndefined();
    expect(withInheritance(subclass!, PLANTED_INDEX).holdsScheduler).toBe(false);
  });
});
