// Which registered methods READ, and what that makes of a call that named one.
//
// THE COMPLEMENT OF THE MUTATION CLAIM, and the half that was missing. Its neighbour
// holds a run-control dispatcher to naming no abort at all; nothing held the other
// direction, so `DaemonCallOptions.signal` being optional made a forgotten signal on a
// read look exactly like a deliberate absence on a mutation. Two reads shipped that
// way — the account-quota seed and the queue list — and neither was visible to a gate
// until the incident that produced them.
//
// THE PARTITION COMES OUT OF THE CONTRACTS AND NOT OUT OF THIS FILE, which is the
// classifier `prerequisite-read-round.test.ts` already established for the repos
// wrappers, taken here to the whole registry: a method's RESPONSE shape says whether
// the call was a reading, because that is what the wire names it. `bindDaemonMethod`
// pairs each method with its response schema in one table, so the classification is
// read off that pairing — a method row added tomorrow is classified by the schema it
// is bound to and is held to the rule without anybody naming it here. The reading
// VERBS themselves live in `daemon-reading-verbs.ts`, which both this file and that
// one derive from, because a closed set spelled in two places moves in one.
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
// AND UNRESOLVED MEANS UNREGISTERED TOO. A method the parse DID reduce to a name the
// registry binds no schema for is not a record — the registry is where reading is
// decided, and a name absent from it decides nothing. Reading `readings.get(method)`
// alone answered `undefined`, which fell through to the record arm and exempted an
// unsignalled read from the rule; a table reader that missed one row (a computed key,
// a namespace-qualified schema) therefore turned that row's every call site green.
// Presence in `readings` is now required of every resolved method.
//
// AND STOPPABILITY IS ASKED OF BOTH SIDES, in the two directions their rules run. A
// read must SHOW the signal that stops it; a record must SHOW it carries none. An
// options argument this parse cannot read satisfies neither, and neither does a signal
// member whose value is not a round's — which is why `SignalArgumentReading` has an
// `"opaque"` and an `"unrecognised"` arm rather than a boolean's silence.

import ts from "typescript";

import {
  consoleSourceModules,
  readConsoleSourceModule,
  readModuleNamed,
} from "../console-source-modules.js";
import { parseSourceText } from "../typescript-source.js";
import { daemonCallSitesIn, type DaemonCallSite } from "./daemon-call-sites.js";
import { DaemonMethodConstantIndex } from "./daemon-method-bindings.js";
import { namesReadingVerb } from "./daemon-reading-verbs.js";

/** Where the method-to-schema table the partition is read off lives. */
const DAEMON_REPLY_REGISTRY_MODULE = "console/bridge/daemon/daemon-reply-registry.ts";

/** The registry's own binding factory — one call per method row. */
const BINDING_FACTORY = "bindDaemonMethod";

/** Where the response schema sits in that factory's arguments. */
const RESPONSE_SCHEMA_ARGUMENT_INDEX = 1;

/** One reading of the console: the wire's partition, and every call made against it. */
export interface ConsoleDaemonCallReading {
  /** Every registered method, and whether its response says it read. */
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
 * Every registered method, and whether its response says it read.
 *
 * Taken off the binding table's own object literal: each property's name is the
 * method and its initializer is the factory call whose second argument names the
 * response schema. Read from the parse rather than from a pattern, because the
 * registry's prose names both the factory and a dozen schemas while explaining them.
 */
export function daemonMethodReadings(
  registrySource: string,
  fileName = "daemon-reply-registry.ts",
): ReadonlyMap<string, boolean> {
  const readings = new Map<string, boolean>();
  for (const binding of bindingTableEntries(parseSourceText(fileName, registrySource))) {
    readings.set(binding.method, namesReadingVerb(binding.responseSchema));
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
 * positive finding — the registry says this method's answer is not a reading — and it
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

/** The methods this site can name that the registry binds no response schema for. */
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
    ? `${named} names ${unregistered.join(", ")}, which the registry binds no response schema for, so nothing here says whether this call reads`
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

/** One row of the registry's binding table. */
interface DaemonMethodBindingRow {
  readonly method: string;
  readonly responseSchema: string;
}

/** Every `"<method>": bindDaemonMethod(request, response)` row in the registry source. */
function bindingTableEntries(parsed: ts.SourceFile): readonly DaemonMethodBindingRow[] {
  const rows: DaemonMethodBindingRow[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && ts.isStringLiteralLike(node.name)) {
      const responseSchema = boundResponseSchema(node.initializer);
      if (responseSchema !== undefined) {
        rows.push({ method: node.name.text, responseSchema });
      }
    }
    node.forEachChild(visit);
  };
  parsed.forEachChild(visit);
  return rows;
}

/** The response schema a binding-factory call names, or `undefined` for anything else. */
function boundResponseSchema(initializer: ts.Expression): string | undefined {
  if (
    !ts.isCallExpression(initializer) ||
    !ts.isIdentifier(initializer.expression) ||
    initializer.expression.text !== BINDING_FACTORY
  ) {
    return undefined;
  }
  const responseSchema = initializer.arguments[RESPONSE_SCHEMA_ARGUMENT_INDEX];
  return responseSchema !== undefined && ts.isIdentifier(responseSchema)
    ? responseSchema.text
    : undefined;
}
