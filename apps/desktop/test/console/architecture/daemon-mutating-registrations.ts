// What the daemon itself says is mutating, read off its own registrations.
//
// The console blocks daemon-bound writes while the supervisor is starting,
// reconnecting, incompatible, offline, or stopped, and `store/shell/shell-state.ts` names
// the set that rule applies to. That tuple's authority is a registration's `mutating`
// flag — and until this gate existed the agreement between the two was prose. A claim
// in a comment is not enforcement: the tuple was resolved by reading the daemon's
// handlers once, by hand, and nothing reported it the next time a handler landed.
//
// WHAT THIS CAN AND CANNOT SETTLE, stated before the mechanism, because the direction
// is the whole design. The daemon has shipped handlers for a fraction of the methods
// the console registers — the growth slate is the rest — so a method ABSENT from these
// registrations is unregistered rather than read-only, and an equality check between
// the two sets would be false in the direction that matters. What a census of what has
// landed supports is a bound from below, and that is exactly what is asserted next
// door: every shipped `mutating: true` registration is named in the console's tuple,
// and nothing in that tuple is shipped `mutating: false`. A corpus-registered verb
// whose handler has not landed is settled by the tuple's own documentation.
//
// THE PARSE IS THE TIER'S, and the walk with it. `readdirSync` and `createSourceFile`
// each have one home in this package and neither is here; a regular expression over
// `mutating:\s*true` would have matched the four in this file's own header.

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { consoleSourceModules, readConsoleSourceModule } from "../console-source-modules.js";
import { forEachDescendant, parseSourceText } from "../typescript-source.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The daemon's IPC surface: every handler module, and the primitives that register
 * beside them.
 *
 * The whole of `ipc/` rather than `ipc/handlers/`, because the `mutating: false` half
 * of the claim is registered outside that directory — the streaming primitive's cancel
 * and the handshake both — and a root that could not see them would assert the
 * agreement in one direction only.
 */
export const DAEMON_IPC_DIRECTORY: string = resolve(
  HERE,
  "..",
  "..",
  "..",
  "..",
  "..",
  join("packages", "runtime-daemon", "src", "ipc"),
);

/** One `registry.register` call, as the daemon wrote it. */
export interface DaemonMethodRegistration {
  readonly method: string;
  readonly mutating: boolean;
  readonly displayPath: string;
}

/** The method-name shape a registration's first argument carries. */
const METHOD_NAME = /^[a-zA-Z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9]*$/;

/**
 * Every method registration in one module's source text.
 *
 * Matched on the CALL rather than on the word: `register` reached through any
 * receiver, whose first argument is a string literal spelled like a method name. The
 * flag defaults to `false` where no options object is passed, which is the registry's
 * own default and not this reader's guess.
 */
export function daemonMethodRegistrationsIn(
  displayPath: string,
  source: string,
): readonly DaemonMethodRegistration[] {
  const parsed = parseSourceText(displayPath, source);
  const found: DaemonMethodRegistration[] = [];
  forEachDescendant(parsed, (node) => {
    if (!ts.isCallExpression(node) || !isRegisterCallee(node.expression)) {
      return;
    }
    const method = node.arguments.find(
      (argument): argument is ts.StringLiteral =>
        ts.isStringLiteral(argument) && METHOD_NAME.test(argument.text),
    );
    if (method === undefined) {
      return;
    }
    found.push({ method: method.text, mutating: mutatingFlagIn(node.arguments), displayPath });
  });
  return found;
}

/** Every registration the daemon's IPC surface carries, in walk order. */
export function daemonIpcRegistrations(): readonly DaemonMethodRegistration[] {
  return consoleSourceModules({ roots: [DAEMON_IPC_DIRECTORY] }).flatMap((module) =>
    daemonMethodRegistrationsIn(module.displayPath, readConsoleSourceModule(module)),
  );
}

/**
 * The shipped mutating registrations a classification does not name.
 *
 * Derived rather than listed: a handler the daemon lands with `mutating: true` is an
 * offender the moment it is not in the console's tuple, and no exemption is admitted —
 * a control that stays live through an outage is the defect, not the report of it.
 */
export function unclassifiedMutatingRegistrations(
  registrations: readonly DaemonMethodRegistration[],
  classifiedMutating: readonly string[],
): readonly string[] {
  return registrations
    .filter(
      (registration) => registration.mutating && !classifiedMutating.includes(registration.method),
    )
    .map((registration) => `${registration.displayPath}: ${registration.method}`);
}

/** The registrations the daemon ships read-only that the console calls mutating. */
export function contradictedRegistrations(
  registrations: readonly DaemonMethodRegistration[],
  classifiedMutating: readonly string[],
): readonly string[] {
  return registrations
    .filter(
      (registration) => !registration.mutating && classifiedMutating.includes(registration.method),
    )
    .map((registration) => `${registration.displayPath}: ${registration.method}`);
}

/** Whether a call's callee is a `register`, through any receiver or none. */
function isRegisterCallee(callee: ts.Expression): boolean {
  if (ts.isPropertyAccessExpression(callee)) {
    return callee.name.text === "register";
  }
  return ts.isIdentifier(callee) && callee.text === "register";
}

/** The `mutating` flag an options argument carries, defaulting to the registry's own. */
function mutatingFlagIn(argumentList: ts.NodeArray<ts.Expression>): boolean {
  for (const argument of argumentList) {
    if (!ts.isObjectLiteralExpression(argument)) {
      continue;
    }
    for (const property of argument.properties) {
      if (
        ts.isPropertyAssignment(property) &&
        ts.isIdentifier(property.name) &&
        property.name.text === "mutating"
      ) {
        return property.initializer.kind === ts.SyntaxKind.TrueKeyword;
      }
    }
  }
  return false;
}
