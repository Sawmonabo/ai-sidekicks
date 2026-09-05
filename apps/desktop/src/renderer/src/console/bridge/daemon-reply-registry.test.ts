// The method registry, held to the corpus's own rules.
//
// Three claims a compiler cannot make: that every method string is a name the wire
// admits, that every binding really is a live schema rather than a placeholder, and
// that the runtime lookup the fixture uses answers exactly for the methods the table
// holds.

import { METHOD_NAME_FORMAT } from "@ai-sidekicks/contracts";

import {
  CONSOLE_DAEMON_METHODS,
  CONSOLE_DAEMON_METHOD_BINDINGS,
  daemonMethodBindingFor,
} from "./daemon-reply-registry.js";
import { GROWTH_OPERATIONS } from "./growth-operations/index.js";

/**
 * Registered method names the canonical-format regex does not accept.
 *
 * One entry, and it is a finding rather than a convenience. The canonical format
 * tightens a method's FIRST segment to lowercase-only — the architecture contract
 * enumerates every ratified namespace root and rejects a camelCase one explicitly —
 * while the provider-account plane's ten verbs are rooted `providerAccount`. The
 * daemon's own `register()` guard evaluates this same regex and throws on mismatch,
 * so as spelled those verbs cannot reach a dispatcher at all. The console reaches
 * one of them and therefore spells it the way the corpus does; which of the two
 * moves — the root or the regex — is not this module's call to make.
 *
 * Listed rather than silently skipped so the divergence is a thing a reader meets,
 * and paired with the case below so it cannot outlive the contradiction.
 */
const FORMAT_DIVERGENCES: ReadonlySet<string> = new Set(["providerAccount.list"]);

describe("the console daemon-method registry", () => {
  it("has a set to check at all", () => {
    // Without this, every assertion below would pass over an empty table — the
    // vacuous-pass shape the console's other census tests guard the same way.
    expect(CONSOLE_DAEMON_METHODS.length).toBeGreaterThan(10);
  });

  it("names methods in the wire's canonical format", () => {
    // `METHOD_NAME_FORMAT` is the daemon registry's OWN regex, imported rather than
    // restated: a lowercase-rooted namespace, camelCase tails, at least one dot. A
    // typo'd or PascalCase name fails here instead of at the first live call.
    const malformed = CONSOLE_DAEMON_METHODS.filter(
      (method) => !METHOD_NAME_FORMAT.test(method) && !FORMAT_DIVERGENCES.has(method),
    );

    expect(malformed).toStrictEqual([]);
  });

  it("keeps the recorded divergences honest in both directions", () => {
    // An exemption that stopped being needed is a stale claim about the corpus, and
    // this is what makes it expire: the day the namespace or the regex moves, this
    // case fails and the entry is deleted rather than carried.
    const stillDiverging = [...FORMAT_DIVERGENCES].filter(
      (method) => !METHOD_NAME_FORMAT.test(method),
    );

    expect(stillDiverging).toStrictEqual([...FORMAT_DIVERGENCES]);
    for (const method of FORMAT_DIVERGENCES) {
      expect(CONSOLE_DAEMON_METHODS).toContain(method);
    }
  });

  it("negative control: the format check rejects the shapes it exists to reject", () => {
    // Proves the needle bites. Without it a regex that matched everything would
    // make the clean result above meaningless.
    expect(METHOD_NAME_FORMAT.test("Session.create")).toBe(false);
    expect(METHOD_NAME_FORMAT.test("sessionCreate")).toBe(false);
    expect(METHOD_NAME_FORMAT.test("presence.read")).toBe(true);
  });

  it("binds two live schemas to every method", () => {
    // A schema that parsed anything would make every reply readable and every
    // request sendable, which is the failure this whole chokepoint exists to
    // prevent — and it would be invisible, because the served path would still
    // work. `undefined` is admitted by no registered request or response here.
    const permissive = CONSOLE_DAEMON_METHODS.filter((method) => {
      const binding = CONSOLE_DAEMON_METHOD_BINDINGS[method];
      return (
        binding.requestSchema.safeParse(undefined).success ||
        binding.responseSchema.safeParse(undefined).success
      );
    });

    expect(permissive).toStrictEqual([]);
  });

  it("cannot be re-pointed at run time", () => {
    // A registry and not a builder. A module that could swap a schema at start-up
    // could change what the console sends on a method without touching the method's
    // own row or the contract that owns the shape.
    expect(Object.isFrozen(CONSOLE_DAEMON_METHOD_BINDINGS)).toBe(true);
    const unfrozen = CONSOLE_DAEMON_METHODS.filter(
      (method) => !Object.isFrozen(CONSOLE_DAEMON_METHOD_BINDINGS[method]),
    );
    expect(unfrozen).toStrictEqual([]);
  });

  it("claims no method the growth slate already claims", () => {
    // The console must hold ONE answer per method. A method in both tables would be
    // parsed against a published schema through `callDaemon` and stood in for by a
    // typed refusal through the growth port, and which one a surface got would
    // depend on which import it reached for. `session.read` is the near miss the
    // admission rule turns on: it has published payloads AND a growth row, so it
    // stays the port's.
    const growthWireMethods = new Set(
      Object.values(GROWTH_OPERATIONS)
        .map((operation) => operation.expectedWireMethod)
        .filter((method): method is string => method !== undefined),
    );
    const claimedTwice = CONSOLE_DAEMON_METHODS.filter((method) => growthWireMethods.has(method));

    expect(claimedTwice).toStrictEqual([]);
    // Negative control: the ledger really does name wire methods, so the clean
    // result above is a disjointness finding and not an empty-set artefact.
    expect(growthWireMethods.has("session.read")).toBe(true);
  });

  it("answers the runtime lookup for exactly the methods it holds", () => {
    // The fixture bridge is handed a call name by a scenario rather than by a typed
    // call site, so this is the one lookup that admits an arbitrary string. Both
    // directions, because an over-eager one would make the fixture refuse scenarios
    // for growth-port operations the corpus has not registered.
    for (const method of CONSOLE_DAEMON_METHODS) {
      expect(daemonMethodBindingFor(method)).toBe(CONSOLE_DAEMON_METHOD_BINDINGS[method]);
    }
    expect(daemonMethodBindingFor("gitflow.branchContextRead")).toBeUndefined();
    expect(daemonMethodBindingFor("toString")).toBeUndefined();
  });
});
