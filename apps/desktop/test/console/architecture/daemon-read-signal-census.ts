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
// is bound to and is held to the rule without anybody naming it here.
//
// WORDS AND NOT SUBSTRINGS, which is the whole difference between a classifier and a
// coincidence. `ChecklistUpdateResponse` CONTAINS "Check" and records; `ListModelsResult`
// carries its reading verb at the head rather than the tail, so a suffix rule misses
// it. Splitting the operation name on its own capital-letter boundaries answers both:
// a reading verb is a WORD of the operation, wherever in the name it sits.
//
// WHY A VERDICT AND NOT A BOOLEAN. Three answers, because a call whose method this
// scan could not resolve is a different fact from one it resolved to a mutation, and
// collapsing them is how an exemption gets granted to whatever the parse cannot see.
// The unresolved arm is held to the READ rule for the same reason the parse fails
// closed: a call that could name a read and hands the door nothing to stop it is the
// defect regardless of which method today's caller passes.

import ts from "typescript";

import {
  consoleSourceModules,
  readConsoleSourceModule,
  readModuleNamed,
} from "../console-source-modules.js";
import { parseSourceText } from "../typescript-source.js";
import {
  DaemonMethodConstantIndex,
  daemonCallSitesIn,
  type DaemonCallSite,
} from "./daemon-call-sites.js";

/** Where the method-to-schema table the partition is read off lives. */
const DAEMON_REPLY_REGISTRY_MODULE = "console/bridge/daemon/daemon-reply-registry.ts";

/** The registry's own binding factory — one call per method row. */
const BINDING_FACTORY = "bindDaemonMethod";

/** Where the response schema sits in that factory's arguments. */
const RESPONSE_SCHEMA_ARGUMENT_INDEX = 1;

/** The nouns a response type is named with, stripped before the verb is looked for. */
const RESPONSE_NOUNS: readonly string[] = ["Response", "Result"];

/** The suffix every bound schema identifier carries. */
const SCHEMA_SUFFIX = "Schema";

/**
 * The operation words that make a call a reading, as the wire's own verbs.
 *
 * Three, and the set is closed on purpose: a fourth reading verb landing in the
 * contracts is a deliberate edit here, where a reviewer meets the classification,
 * rather than a method that silently classifies as a mutation and stops being held to
 * the signal rule.
 */
const READING_VERBS: readonly string[] = ["Read", "List", "Check"];

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
 * call sites name a method constant another module declares.
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
export type DaemonCallSiteVerdict = "read" | "record" | "unresolved";

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
    readings.set(binding.method, isReadingResponse(binding.responseSchema));
  }
  return readings;
}

/** Whether a response schema identifier names a reading's answer. */
export function isReadingResponse(responseSchemaName: string): boolean {
  return operationWords(responseSchemaName).some((word) => READING_VERBS.includes(word));
}

/**
 * What this call site is: a read, a record, or a method the parse could not resolve.
 *
 * A SITE THAT CAN NAME A READ IS A READ. Where a parameter's declared union admits
 * both kinds the verdict is `"read"`, because the call has to be stoppable on the arm
 * where it is one and no signal can be conditional on which arm ran.
 */
export function classifyDaemonCallSite(
  site: DaemonCallSite,
  readings: ReadonlyMap<string, boolean>,
): DaemonCallSiteVerdict {
  if (site.resolvedMethods.length === 0) {
    return "unresolved";
  }
  return site.resolvedMethods.some((method) => readings.get(method) === true) ? "read" : "record";
}

/**
 * The sites that must carry a signal and do not, each with its reason.
 *
 * THE UNRESOLVED ARM IS HELD TO THIS RULE and not exempted from it — see this
 * module's header. A site reported here is fixed either by handing it the round it
 * belongs to or by narrowing the method it names until the parse can see that it
 * records; both are the call site saying what it is, which is what the gate wants.
 */
export function unsignalledReadOffenders(
  sites: readonly DaemonCallSite[],
  readings: ReadonlyMap<string, boolean>,
): readonly string[] {
  return sites
    .filter((site) => !site.carriesSignal && classifyDaemonCallSite(site, readings) !== "record")
    .map((site) => `${describeSite(site)} — ${describeUnsignalled(site, readings)}`);
}

/**
 * The sites that record and were handed a signal anyway.
 *
 * The positive control the mutation claim owes: a durable act that has reached the
 * daemon has HAPPENED, so a signal on one would abandon the console's half of a write
 * mid-flight and leave a person reading a surface that says it did not occur.
 */
export function signalledRecordOffenders(
  sites: readonly DaemonCallSite[],
  readings: ReadonlyMap<string, boolean>,
): readonly string[] {
  return sites
    .filter((site) => site.carriesSignal && classifyDaemonCallSite(site, readings) === "record")
    .map(
      (site) =>
        `${describeSite(site)} — records ${site.resolvedMethods.join(", ")} and was handed a signal`,
    );
}

/** Where a failure sends a reader: the module, and the line the call is on. */
function describeSite(site: DaemonCallSite): string {
  return `${site.displayPath}:${String(site.line)}`;
}

/** Why this unsignalled site was reported, in the reader's own terms. */
function describeUnsignalled(site: DaemonCallSite, readings: ReadonlyMap<string, boolean>): string {
  const named = site.methodExpression === "" ? "no method" : site.methodExpression;
  if (classifyDaemonCallSite(site, readings) === "unresolved") {
    return `${named} resolves to no registered method, so this call could name a read and can be stopped by nothing`;
  }
  const reads = site.resolvedMethods.filter((method) => readings.get(method) === true);
  return `${named} reads (${reads.join(", ")}) and was handed no signal`;
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

/**
 * The operation a response schema names, split into its own capital-bounded words.
 *
 * `QueueItemListResponseSchema` is the operation `QueueItemList` and the words
 * `Queue`, `Item`, `List`; `RunControlAckSchema` carries no response noun to strip and
 * is `Run`, `Control`, `Ack`. Stripping the noun matters because it is where a reading
 * verb would otherwise be looked for and never found.
 */
function operationWords(responseSchemaName: string): readonly string[] {
  let operation = responseSchemaName.endsWith(SCHEMA_SUFFIX)
    ? responseSchemaName.slice(0, -SCHEMA_SUFFIX.length)
    : responseSchemaName;
  for (const noun of RESPONSE_NOUNS) {
    if (operation.endsWith(noun)) {
      operation = operation.slice(0, -noun.length);
      break;
    }
  }
  return operation.match(/[A-Z][a-z0-9]*/g) ?? [];
}
