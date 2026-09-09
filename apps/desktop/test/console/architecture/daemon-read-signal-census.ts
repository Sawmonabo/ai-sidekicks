// Which registered methods READ, and what that makes of a call that named one.
//
// THE COMPLEMENT OF THE MUTATION CLAIM, and the half that was missing. Its neighbour
// holds a run-control dispatcher to naming no abort at all; nothing held the other
// direction, so `DaemonCallOptions.signal` being optional made a forgotten signal on a
// read look exactly like a deliberate absence on a mutation. Two reads shipped that
// way — the account-quota seed and the queue list — and neither was visible to a gate
// until the incident that produced them.
//
// THE PARTITION IS THE CONSOLE'S OWN, AND THIS FILE IMPORTS IT. It used to be read
// off the WORDS of each bound schema's operation — `Read`, `List`, `Check` — and that
// is a naming convention wearing a classifier's clothes, wrong in both directions: a
// durable write whose reply schema happens to carry one of those words classified as a
// read and was then required to carry an abort signal that would abandon it, and a read
// named with a fourth verb classified as a record and was excused from carrying one.
// It was also a SECOND OPINION — `store/shell/shell-mutation-block.ts` says which methods
// this console writes with too — and two answers to that question could disagree with
// nothing reporting it.
//
// SO THE SOURCE IS `bridge/daemon/daemon-method-classification.ts`, which declares the
// partition once as a map total over the registry's own key set: a method added to the
// contract is a missing-property error there rather than a row that classifies itself
// by default. No name is parsed for meaning here any more, which also retires the alias
// hazard the word rule carried — `WorkspaceListResponseSchema as WorkspaceResponseSchema`
// used to drop the whole classification out of the identifier a row carried.
//
// AND THE SHELL BLOCK IS HELD TO THAT SAME PARTITION rather than trusted to agree with
// it: `read-signal-chokepoint.test.ts` asserts that every registered member of
// `MUTATING_DAEMON_METHODS` classifies as a record. That roster is deliberately a
// SUBSET — it names the writes a console surface offers a control for, and a write no
// surface dispatches has no control to disable — so the claim runs in the one direction
// a subset supports, exactly as `daemon-mutating-registrations.ts` runs its own.
//
// WHAT THE REGISTRY SOURCE IS STILL READ FOR IS THE SET AND NOT THE KIND. The keys come
// off the binding table as WRITTEN, so a row this reader misses is a method absent from
// `readings` and every call naming it is reported as unresolved rather than falling
// through to the record arm; and a row naming a method the console does not register is
// left out for the same reason, because the classification covers the contract's keys
// and nothing else.
//
// FOUR VERDICTS, BECAUSE THREE COLLAPSED TWO FACTS INTO ONE. A call whose method this
// scan could not resolve is a different fact from one it resolved to a mutation, and
// collapsing them is how an exemption gets granted to whatever the parse cannot see.
// And a method union admitting BOTH kinds is a fourth fact again: reading it as
// `"read"` satisfied the signal check on the read arm while `stoppableRecordOffenders`
// skipped the site entirely — its verdict was not `"record"` — so a signal that would
// abandon a durable mutation passed both readings. That union is `"mixed"`, it fails
// the gate on its own reading whatever it was handed, and the fix is at the call: split
// it, or narrow the union until one call is one kind.
//
// UNRESOLVED IS ITS OWN REPORT AND NOT THE READ RULE'S TAIL, which is the second thing
// three verdicts got wrong. Holding it to the read rule made its report CONDITIONAL on
// the options — so a generic binder over the whole registry that passed `{ signal }`
// resolved no method, satisfied `signalArgument === "present"`, and was dropped by
// every one of the three readings at once. No signal argument settles what a call
// whose method is unknown is: the defect is the unknown method. So the four verdicts
// are four readings, each owning its own sites, and `unresolvedMethodOffenders` reports
// whatever it was handed exactly as the mixed reading does.
//
// AND UNRESOLVED MEANS UNCLASSIFIED TOO. A method the parse DID reduce to a name the
// classified table does not carry is not a record — the classification is where reading
// is decided, and a name absent from it decides nothing. Reading `readings.get(method)`
// alone answered `undefined`, which fell through to the record arm and exempted an
// unsignalled read from the rule; a table reader that missed one row (a computed key, a
// spread) therefore turned that row's every call site green. Presence in `readings` is
// now required of every resolved method.
//
// AND STOPPABILITY IS ASKED OF BOTH SIDES, in the two directions their rules run. A
// read must SHOW the signal that stops it; a record must SHOW it carries none. An
// options argument this parse cannot read satisfies neither, and neither does a signal
// member whose value is not a round's — which is why `SignalArgumentReading` has an
// `"opaque"` and an `"unrecognised"` arm rather than a boolean's silence.

import ts from "typescript";

import { READING_DAEMON_METHODS } from "../../../src/renderer/src/console/bridge/daemon/daemon-method-classification.js";
import { CONSOLE_DAEMON_METHODS } from "../../../src/renderer/src/console/bridge/daemon/daemon-reply-registry.js";
import {
  consoleSourceModules,
  readConsoleSourceModule,
  readModuleNamed,
} from "../console-source-modules.js";
import { parseSourceText } from "../typescript-source.js";
import { daemonCallSitesIn, type DaemonCallSite } from "./daemon-call-sites.js";
import { DaemonMethodConstantIndex } from "./daemon-method-constants.js";

/** Where the method table whose rows the partition is applied to lives. */
const DAEMON_REPLY_REGISTRY_MODULE = "console/bridge/daemon/daemon-reply-registry.ts";

/** The registry's own binding factory — one call per method row. */
const BINDING_FACTORY = "bindDaemonMethod";

/** Every method the console's contract names, as the strings a parsed row carries. */
const REGISTERED_METHODS: ReadonlySet<string> = new Set<string>(CONSOLE_DAEMON_METHODS);

/** The half of those the console declares a reading, as the same strings. */
const READING_METHODS: ReadonlySet<string> = new Set<string>(READING_DAEMON_METHODS);

/** One reading of the console: the wire's partition, and every call made against it. */
export interface ConsoleDaemonCallReading {
  /** Every classified method of the registry's table, and whether it reads. */
  readonly readings: ReadonlyMap<string, boolean>;
  /** Every door call under the console source roots, in scan order. */
  readonly sites: readonly DaemonCallSite[];
}

/**
 * Walk the console, read the registry's partition, and resolve every door call once.
 *
 * THE WALK LIVES BESIDE THE MODEL AND THE NEEDLES STAY PURE, which is the split
 * `daemon-mutating-registrations.ts` already takes: everything above this function
 * takes source text as a parameter, so a control drives it with a source whose verdict
 * is known, and this is the one place that reads the real tree. The constant index is
 * folded across the WHOLE scan before any call is resolved, because two of the console's
 * call sites name a method constant another module declares and reach it by import.
 */
export function readConsoleDaemonCalls(): ConsoleDaemonCallReading {
  const modules = consoleSourceModules();
  const sourceByModule = modules.map((module) => ({
    displayPath: module.displayPath,
    source: readConsoleSourceModule(module),
  }));
  const readings = daemonMethodReadings(
    readModuleNamed(modules, DAEMON_REPLY_REGISTRY_MODULE, "the daemon reply registry"),
  );
  const constants = new DaemonMethodConstantIndex([...readings.keys()]);
  for (const module of sourceByModule) {
    constants.add(module.source, module.displayPath);
  }
  return {
    readings,
    sites: sourceByModule.flatMap((module) =>
      daemonCallSitesIn(module.displayPath, module.source, constants),
    ),
  };
}

/** What one call site is, once its method has been classified. */
export type DaemonCallSiteVerdict = "read" | "record" | "mixed" | "unresolved";

/**
 * Every method the binding table names that the console classifies, and its kind.
 *
 * TWO SOURCES, AND EACH ANSWERS THE HALF IT OWNS. The KEYS are taken off the binding
 * table's own object literal — each property's name is the method and its initializer
 * is the factory call — read from the parse rather than from a pattern, because the
 * registry's prose names both the factory and a dozen schemas while explaining them.
 * The KIND is `daemon-method-classification.ts`', which is total over the contract's
 * keys, so nothing here decides what a method is from how it or its schema is spelled.
 *
 * A parsed row naming a method the contract does not carry is left OUT rather than
 * guessed at: the classification covers the contract's keys and nothing else, and a
 * method absent from this map is reported by the unresolved reading, which no options
 * argument satisfies.
 */
export function daemonMethodReadings(
  registrySource: string,
  fileName = "daemon-reply-registry.ts",
): ReadonlyMap<string, boolean> {
  const parsed = parseSourceText(fileName, registrySource);
  const readings = new Map<string, boolean>();
  for (const method of boundMethodNames(parsed)) {
    if (REGISTERED_METHODS.has(method)) {
      readings.set(method, READING_METHODS.has(method));
    }
  }
  return readings;
}

/**
 * What this call site is: a read, a record, a union of both, or an unresolved method.
 *
 * A UNION OF BOTH IS NEITHER. Reading it as `"read"` made the signal check pass on a
 * site whose record arm the signal would abandon, and reading it as `"record"` would
 * exempt the read arm from carrying one — no single verdict is right for a call that
 * is two kinds, which is why the answer is that the call has to stop being two kinds.
 *
 * AND A NAME THE REGISTRY DOES NOT BIND IS UNRESOLVED, not a record. `"record"` is a
 * positive finding — the console classifies this method as a write — and it
 * cannot be read off a method the registry never mentions. Requiring PRESENCE rather
 * than a `true` reading is what keeps a missed table row from exempting its own calls.
 */
export function classifyDaemonCallSite(
  site: DaemonCallSite,
  readings: ReadonlyMap<string, boolean>,
): DaemonCallSiteVerdict {
  if (site.resolvedMethods.length === 0 || unregisteredMethodsOf(site, readings).length > 0) {
    return "unresolved";
  }
  const reads = readMethodsOf(site, readings);
  if (reads.length === site.resolvedMethods.length) {
    return "read";
  }
  return reads.length === 0 ? "record" : "mixed";
}

/**
 * The sites that must show the signal that stops them and do not, each with its reason.
 *
 * A site reported here is fixed by handing it the round it belongs to — the signal its
 * own read line mints — rather than by any member merely named `signal`, which is what
 * `SignalArgumentReading`'s `"unrecognised"` arm refuses on this rule's behalf.
 */
export function unstoppableReadOffenders(
  sites: readonly DaemonCallSite[],
  readings: ReadonlyMap<string, boolean>,
): readonly string[] {
  return sites
    .filter(
      (site) =>
        site.signalArgument !== "present" && classifyDaemonCallSite(site, readings) === "read",
    )
    .map((site) => `${describeSite(site)} — ${describeUnstoppableRead(site, readings)}`);
}

/**
 * The sites that record and cannot show they are unstoppable.
 *
 * The positive control the mutation claim owes: a durable act that has reached the
 * daemon has HAPPENED, so a signal on one would abandon the console's half of a write
 * mid-flight and leave a person reading a surface that says it did not occur. An
 * options argument this parse cannot read is reported beside a signal it can, because
 * the rule is that the call SHOWS it carries none and an unreadable one shows nothing.
 */
export function stoppableRecordOffenders(
  sites: readonly DaemonCallSite[],
  readings: ReadonlyMap<string, boolean>,
): readonly string[] {
  return sites
    .filter(
      (site) =>
        site.signalArgument !== "absent" && classifyDaemonCallSite(site, readings) === "record",
    )
    .map((site) => `${describeSite(site)} — ${describeStoppableRecord(site)}`);
}

/**
 * The sites whose method union names a read and a record at once.
 *
 * Reported whatever they were handed, because no signal argument makes such a call
 * right: the signal cannot be conditional on which arm ran, and both arms are reachable
 * from the one line.
 */
export function mixedMethodOffenders(
  sites: readonly DaemonCallSite[],
  readings: ReadonlyMap<string, boolean>,
): readonly string[] {
  return sites
    .filter((site) => classifyDaemonCallSite(site, readings) === "mixed")
    .map((site) => {
      const reads = readMethodsOf(site, readings);
      const records = site.resolvedMethods.filter((method) => !reads.includes(method));
      return `${describeSite(site)} — ${namedMethodOf(site)} names both a read (${reads.join(", ")}) and a record (${records.join(", ")}); split the call or narrow the union so one call is one kind`;
    });
}

/** The methods this site can name that the classified method table does not carry. */
function unregisteredMethodsOf(
  site: DaemonCallSite,
  readings: ReadonlyMap<string, boolean>,
): readonly string[] {
  return site.resolvedMethods.filter((method) => !readings.has(method));
}

/** The methods this site can name whose response says they read. */
function readMethodsOf(
  site: DaemonCallSite,
  readings: ReadonlyMap<string, boolean>,
): readonly string[] {
  return site.resolvedMethods.filter((method) => readings.get(method) === true);
}

/** Where a failure sends a reader: the module, and the line the call is on. */
function describeSite(site: DaemonCallSite): string {
  return `${site.displayPath}:${String(site.line)}`;
}

/** The method argument as the source wrote it, or the fact that there was none. */
function namedMethodOf(site: DaemonCallSite): string {
  return site.methodExpression === "" ? "no method" : site.methodExpression;
}

/** Why this site was reported as unable to show what stops it. */
function describeUnstoppableRead(
  site: DaemonCallSite,
  readings: ReadonlyMap<string, boolean>,
): string {
  const named = namedMethodOf(site);
  const reads = readMethodsOf(site, readings).join(", ");
  if (site.signalArgument === "opaque") {
    return `${named} reads (${reads}) and was handed options this parse cannot read, so nothing here shows a signal`;
  }
  return site.signalArgument === "unrecognised"
    ? `${named} reads (${reads}) and was handed a signal member this parse cannot tie to a read round`
    : `${named} reads (${reads}) and was handed no signal`;
}

/** Why this recording site was reported as possibly stoppable. */
function describeStoppableRecord(site: DaemonCallSite): string {
  const methods = site.resolvedMethods.join(", ");
  if (site.signalArgument === "opaque") {
    return `records ${methods} and was handed options this parse cannot read, so nothing here shows it carries no signal`;
  }
  return site.signalArgument === "unrecognised"
    ? `records ${methods} and was handed a signal member this parse cannot tie to a read round`
    : `records ${methods} and was handed a signal`;
}

/** Why this site's method could not be reduced to something the registry classifies. */
function describeUnresolvedMethod(
  site: DaemonCallSite,
  readings: ReadonlyMap<string, boolean>,
): string {
  const named = namedMethodOf(site);
  const unregistered = unregisteredMethodsOf(site, readings);
  return unregistered.length > 0
    ? `${named} names ${unregistered.join(", ")}, which the classified method table does not carry, so nothing here says whether this call reads`
    : `${named} resolves to no registered method, so this call could name a read and nothing here says what stops it`;
}

/**
 * The sites whose method this scan could not reduce to a classified registry row.
 *
 * REPORTED WHATEVER THEY WERE HANDED, for the mixed reading's reason rather than the
 * read rule's: a signal argument answers what stops a call and this reading is about
 * a call whose KIND is unknown, so no options argument settles it. Holding it to the
 * read rule instead made the report conditional on the options and dropped every
 * unresolved site that happened to pass one.
 */
export function unresolvedMethodOffenders(
  sites: readonly DaemonCallSite[],
  readings: ReadonlyMap<string, boolean>,
): readonly string[] {
  return sites
    .filter((site) => classifyDaemonCallSite(site, readings) === "unresolved")
    .map((site) => `${describeSite(site)} — ${describeUnresolvedMethod(site, readings)}`);
}

/** Every method named by a `"<method>": bindDaemonMethod(…)` row in the source. */
function boundMethodNames(parsed: ts.SourceFile): readonly string[] {
  const methods: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isStringLiteralLike(node.name) &&
      callsBindingFactory(node.initializer)
    ) {
      methods.push(node.name.text);
    }
    node.forEachChild(visit);
  };
  parsed.forEachChild(visit);
  return methods;
}

/** Whether this initializer is the registry's own binding factory being called. */
function callsBindingFactory(initializer: ts.Expression): boolean {
  return (
    ts.isCallExpression(initializer) &&
    ts.isIdentifier(initializer.expression) &&
    initializer.expression.text === BINDING_FACTORY
  );
}
