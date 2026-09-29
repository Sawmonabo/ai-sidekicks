// The method registry, held to the corpus's own rules.
//
// Claims a compiler cannot make: that every method string is a name the wire admits,
// that every binding really is a live schema rather than a placeholder, and that the
// runtime lookup the fixture uses answers exactly for the methods the table holds.

import { METHOD_NAME_FORMAT } from "@ai-sidekicks/contracts";

import {
  REGISTERED_DAEMON_METHODS,
  DAEMON_METHOD_BINDINGS,
  daemonMethodBindingFor,
} from "./daemon-reply-registry.js";

describe("the console daemon-method registry", () => {
  it("has a set to check at all", () => {
    // Without this, every assertion below would pass over an empty table — the
    // vacuous-pass shape the console's other census tests guard the same way.
    expect(REGISTERED_DAEMON_METHODS.length).toBeGreaterThan(10);
  });

  it("names methods in the wire's canonical format", () => {
    // `METHOD_NAME_FORMAT` is the daemon registry's OWN regex, imported rather than
    // restated: every segment starts lowercase and may carry camelCase, at least one
    // dot. A typo'd or PascalCase name fails here instead of at the first live call.
    //
    // No exemption. This assertion carried one until 2026-09-05 — `providerAccount.list`,
    // whose camelCase root the regex rejected while the architecture contract registered
    // the namespace — and the contradiction was settled in the regex's favor rather than
    // the namespace's, so every bound method now matches the real thing.
    const malformed = REGISTERED_DAEMON_METHODS.filter(
      (method) => !METHOD_NAME_FORMAT.test(method),
    );

    expect(malformed).toStrictEqual([]);
  });

  it("negative control: the format check rejects the shapes it exists to reject", () => {
    // Proves the needle bites. Without it a regex that matched everything would
    // make the clean result above meaningless — and the root widening is exactly the
    // kind of change that could have loosened it that far, so the uppercase-STARTING
    // root is asserted here beside the camelCase one the widening admits.
    expect(METHOD_NAME_FORMAT.test("Session.create")).toBe(false);
    expect(METHOD_NAME_FORMAT.test("ProviderAccount.list")).toBe(false);
    expect(METHOD_NAME_FORMAT.test("sessionCreate")).toBe(false);
    expect(METHOD_NAME_FORMAT.test("presence.read")).toBe(true);
    expect(METHOD_NAME_FORMAT.test("providerAccount.list")).toBe(true);
  });

  it("binds two live schemas to every method", () => {
    // A schema that parsed anything would make every reply readable and every
    // request sendable, which is the failure this whole chokepoint exists to
    // prevent — and it would be invisible, because the served path would still
    // work. `undefined` is admitted by no registered request or response here.
    const permissive = REGISTERED_DAEMON_METHODS.filter((method) => {
      const binding = DAEMON_METHOD_BINDINGS[method];
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
    expect(Object.isFrozen(DAEMON_METHOD_BINDINGS)).toBe(true);
    const unfrozen = REGISTERED_DAEMON_METHODS.filter(
      (method) => !Object.isFrozen(DAEMON_METHOD_BINDINGS[method]),
    );
    expect(unfrozen).toStrictEqual([]);
  });

  it("answers the runtime lookup for exactly the methods it holds", () => {
    // The fixture bridge is handed a call name by a scenario rather than by a typed
    // call site, so this is the one lookup that admits an arbitrary string. Both
    // directions, because an over-eager one would make the fixture refuse scenarios
    // for operations the corpus has not registered.
    for (const method of REGISTERED_DAEMON_METHODS) {
      expect(daemonMethodBindingFor(method)).toBe(DAEMON_METHOD_BINDINGS[method]);
    }
    expect(daemonMethodBindingFor("gitflow.branchContextRead")).toBeUndefined();
    expect(daemonMethodBindingFor("toString")).toBeUndefined();
  });
});
