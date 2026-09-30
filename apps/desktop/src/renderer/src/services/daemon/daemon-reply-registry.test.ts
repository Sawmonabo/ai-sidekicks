// The method registry, held to the corpus's own rules: every method string is a name the wire
// admits, every binding is a live schema, and the runtime lookup answers exactly for the methods
// the table holds.

import { METHOD_NAME_FORMAT } from "@ai-sidekicks/contracts";

import { REGISTERED_DAEMON_METHODS } from "./daemon-method-contract.js";
import { DAEMON_METHOD_BINDINGS, daemonMethodBindingFor } from "./daemon-reply-registry.js";

describe("the console daemon-method registry", () => {
  it("has a set to check at all", () => {
    // Without it, every assertion below passes over an empty table.
    expect(REGISTERED_DAEMON_METHODS.length).toBeGreaterThan(10);
  });

  it("names methods in the wire's canonical format", () => {
    // `METHOD_NAME_FORMAT` is the daemon registry's own regex: lowercase-initial segments that
    // may carry camelCase, with at least one dot. A typo or PascalCase name fails here and not at
    // the first live call.
    const malformed = REGISTERED_DAEMON_METHODS.filter(
      (method) => !METHOD_NAME_FORMAT.test(method),
    );

    expect(malformed).toStrictEqual([]);
  });

  it("negative control: the format check rejects the shapes it exists to reject", () => {
    // Without it, a regex that matched everything would make the clean result above
    // meaningless; the uppercase-initial root is asserted beside the camelCase one it admits.
    expect(METHOD_NAME_FORMAT.test("Session.create")).toBe(false);
    expect(METHOD_NAME_FORMAT.test("ProviderAccount.list")).toBe(false);
    expect(METHOD_NAME_FORMAT.test("sessionCreate")).toBe(false);
    expect(METHOD_NAME_FORMAT.test("presence.read")).toBe(true);
    expect(METHOD_NAME_FORMAT.test("providerAccount.list")).toBe(true);
  });

  it("binds two live schemas to every method", () => {
    // A schema that parsed anything would make every reply readable and every request
    // sendable, invisibly. No registered request or response admits `undefined`.
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
    // A module that could swap a schema at start-up could change what the console sends
    // without touching the contract that owns the shape.
    expect(Object.isFrozen(DAEMON_METHOD_BINDINGS)).toBe(true);
    const unfrozen = REGISTERED_DAEMON_METHODS.filter(
      (method) => !Object.isFrozen(DAEMON_METHOD_BINDINGS[method]),
    );
    expect(unfrozen).toStrictEqual([]);
  });

  it("answers the runtime lookup for exactly the methods it holds", () => {
    // The one lookup that admits an arbitrary string. Both directions are checked, because an
    // over-eager one would make the fixture refuse scenarios for unregistered operations.
    for (const method of REGISTERED_DAEMON_METHODS) {
      expect(daemonMethodBindingFor(method)).toBe(DAEMON_METHOD_BINDINGS[method]);
    }
    expect(daemonMethodBindingFor("gitflow.branchContextRead")).toBeUndefined();
    expect(daemonMethodBindingFor("toString")).toBeUndefined();
  });
});
