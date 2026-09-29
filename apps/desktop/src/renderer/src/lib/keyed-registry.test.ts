// One registry, three policies, and the refusal each of them raises.
//
// The reason this module exists is that five registries had already diverged on
// what a second registration MEANS. So the cases below are organised by policy
// rather than by method: the question a reader has is "what happens on a repeat
// here", and the answer has to be readable per policy or the parameter is just a
// switch statement nobody can audit.
//
// The refusals are asserted on their `code`, not on their message text. A catch
// site renders `code` verbatim and branches on it; message wording is prose that
// may be improved, and a test pinned to prose makes improving it a test failure.

import { describe, expect, it } from "vitest";
import {
  DUPLICATE_POLICIES,
  DuplicateRegistrationError,
  KeyedRegistry,
  lookupOrThrow,
} from "./keyed-registry.js";
import { ConsoleRefusalError, isConsoleRefusal, type ConsoleRefusal } from "./refusal.js";

interface OwnedCommand {
  readonly owner: string;
  readonly label: string;
}

function throwingCommandRegistry(): KeyedRegistry<string, OwnedCommand> {
  return new KeyedRegistry<string, OwnedCommand>({
    duplicatePolicy: "throw",
    describeWhat: "command",
  });
}

function hintingCommandRegistry(duplicateHint: string): KeyedRegistry<string, OwnedCommand> {
  return new KeyedRegistry<string, OwnedCommand>({
    duplicatePolicy: "throw",
    describeWhat: "command",
    duplicateHint,
  });
}

function idempotentCommandRegistry(): KeyedRegistry<string, OwnedCommand> {
  return new KeyedRegistry<string, OwnedCommand>({
    duplicatePolicy: "idempotent",
    describeWhat: "command",
  });
}

function ownerScopedSlotRegistry(): KeyedRegistry<string, OwnedCommand> {
  return new KeyedRegistry<string, OwnedCommand>({
    duplicatePolicy: "owner-scoped",
    describeWhat: "surface slot",
    ownerOf: (command) => command.owner,
  });
}

interface RefusedRegistration extends ConsoleRefusal {
  readonly key: string;
}

/** The refusal a thrown registration carries, or a failure naming what came instead. */
function refusalFrom(run: () => void): RefusedRegistration {
  try {
    run();
  } catch (registrationFailure: unknown) {
    if (registrationFailure instanceof DuplicateRegistrationError) {
      return { ...registrationFailure.refusal, key: registrationFailure.key };
    }
    throw registrationFailure;
  }
  throw new Error("the registration was admitted where a refusal was expected");
}

describe("DuplicatePolicy — three answers, and every one of them reached", () => {
  it("names exactly the three the module claims", () => {
    expect(DUPLICATE_POLICIES).toStrictEqual(["throw", "idempotent", "owner-scoped"]);
  });

  it("gives every policy a defined answer to a repeat, so none falls through", () => {
    // Walked from the tuple rather than retyped. A fourth policy added to the union
    // alone would leave `register`'s switch returning undefined for it, and this is
    // the case that turns that into a failure instead of a value nobody looked at.
    const outcomes = DUPLICATE_POLICIES.map((duplicatePolicy) => {
      const registry = new KeyedRegistry<string, OwnedCommand>({
        duplicatePolicy,
        describeWhat: "command",
        ownerOf: (command) => command.owner,
      });
      registry.register("boot", { owner: "frame", label: "Boot" });
      try {
        return registry.register("boot", { owner: "palette", label: "Boot again" })
          ? "replaced"
          : "ignored";
      } catch (repeatFailure: unknown) {
        return repeatFailure instanceof DuplicateRegistrationError ? "refused" : "unhandled";
      }
    });

    expect(outcomes).toStrictEqual(["refused", "ignored", "refused"]);
  });
});

describe("KeyedRegistry — the throw policy", () => {
  it("admits the first registration and reports that the registry changed", () => {
    const registry = throwingCommandRegistry();
    expect(registry.register("open-palette", { owner: "palette", label: "Open" })).toBe(true);
    expect(registry.size).toBe(1);
  });

  it("refuses a repeat, naming the key and the console refusal code", () => {
    const registry = throwingCommandRegistry();
    registry.register("open-palette", { owner: "palette", label: "Open" });

    const refusal = refusalFrom(() => {
      registry.register("open-palette", { owner: "frame", label: "Also open" });
    });

    expect(refusal.code).toBe("duplicate-registration");
    expect(refusal.origin).toBe("keyed-registry");
    expect(refusal.key).toBe("open-palette");
    expect(refusal.detail).toContain("command");
  });

  it("carries the per-registry hint, so the refusal says what breaks HERE", () => {
    const registry = hintingCommandRegistry("two families cannot own one command id");
    registry.register("open-palette", { owner: "palette", label: "Open" });

    const refusal = refusalFrom(() => {
      registry.register("open-palette", { owner: "frame", label: "Also open" });
    });

    expect(refusal.detail).toContain("two families cannot own one command id");
  });

  it("keeps the first value, so behaviour does not depend on module import order", () => {
    const registry = throwingCommandRegistry();
    registry.register("open-palette", { owner: "palette", label: "Open" });
    refusalFrom(() => {
      registry.register("open-palette", { owner: "frame", label: "Also open" });
    });

    expect(registry.get("open-palette")?.owner).toBe("palette");
  });

  it("raises a refusal a catch site can render without translating it", () => {
    const registry = throwingCommandRegistry();
    registry.register("open-palette", { owner: "palette", label: "Open" });

    let raised: unknown;
    try {
      registry.register("open-palette", { owner: "frame", label: "Also open" });
    } catch (registrationFailure: unknown) {
      raised = registrationFailure;
    }

    expect(raised).toBeInstanceOf(ConsoleRefusalError);
    expect(raised).toBeInstanceOf(Error);
    expect((raised as DuplicateRegistrationError).name).toBe("DuplicateRegistrationError");
    expect(isConsoleRefusal((raised as DuplicateRegistrationError).refusal)).toBe(true);
  });
});

describe("KeyedRegistry — the idempotent policy", () => {
  it("accepts a repeat as a no-op and says the registry did not change", () => {
    const registry = idempotentCommandRegistry();
    expect(registry.register("boot", { owner: "frame", label: "Boot" })).toBe(true);
    expect(registry.register("boot", { owner: "frame", label: "Boot again" })).toBe(false);
    expect(registry.get("boot")?.label).toBe("Boot");
    expect(registry.size).toBe(1);
  });

  it("negative control: the same repeat under the throw policy is refused", () => {
    // Without this, a `register` that never threw at all would pass every
    // idempotent case while silently disarming the throw policy.
    const registry = throwingCommandRegistry();
    registry.register("boot", { owner: "frame", label: "Boot" });
    expect(() => {
      registry.register("boot", { owner: "frame", label: "Boot again" });
    }).toThrow(DuplicateRegistrationError);
  });
});

describe("KeyedRegistry — the owner-scoped policy", () => {
  it("lets the same owner replace its own registration", () => {
    const registry = ownerScopedSlotRegistry();
    registry.register("timeline", { owner: "ledger", label: "Ledger" });

    expect(registry.register("timeline", { owner: "ledger", label: "Ledger v2" })).toBe(true);
    expect(registry.get("timeline")?.label).toBe("Ledger v2");
  });

  it("refuses a different owner, naming both parties", () => {
    const registry = ownerScopedSlotRegistry();
    registry.register("timeline", { owner: "ledger", label: "Ledger" });

    const refusal = refusalFrom(() => {
      registry.register("timeline", { owner: "workflows", label: "Workflow" });
    });

    expect(refusal.code).toBe("owner-conflict");
    expect(refusal.detail).toContain("ledger");
    expect(refusal.detail).toContain("workflows");
  });

  it("raises the SAME conflict from registerAll as from register", () => {
    // The two paths used to carry hand-copied message text, which is how one of
    // them drifts. They are one builder now, and this is what says so.
    const single = ownerScopedSlotRegistry();
    single.register("timeline", { owner: "ledger", label: "Ledger" });
    const batched = ownerScopedSlotRegistry();
    batched.register("timeline", { owner: "ledger", label: "Ledger" });

    const fromRegister = refusalFrom(() => {
      single.register("timeline", { owner: "workflows", label: "Workflow" });
    });
    const fromRegisterAll = refusalFrom(() => {
      batched.registerAll([["timeline", { owner: "workflows", label: "Workflow" }]]);
    });

    expect(fromRegisterAll).toStrictEqual(fromRegister);
  });

  it("refuses at construction when it has no way to read an owner", () => {
    // At construction rather than at the first duplicate: a registry that discovers
    // it cannot honour its policy only when a conflict arrives has already admitted
    // the conflicting registration.
    const constructWithoutOwnerReader = (): KeyedRegistry<string, OwnedCommand> =>
      new KeyedRegistry<string, OwnedCommand>({
        duplicatePolicy: "owner-scoped",
        describeWhat: "surface slot",
      });

    let raised: unknown;
    try {
      constructWithoutOwnerReader();
    } catch (constructionFailure: unknown) {
      raised = constructionFailure;
    }

    expect(raised).toBeInstanceOf(ConsoleRefusalError);
    expect((raised as ConsoleRefusalError).refusal.code).toBe("owner-reader-missing");
  });

  it("negative control: the same registry WITH an owner reader constructs", () => {
    expect(() => ownerScopedSlotRegistry()).not.toThrow();
  });
});

describe("KeyedRegistry — registerAll is atomic", () => {
  it("stores nothing when one entry in the batch is refused", () => {
    const registry = throwingCommandRegistry();
    registry.register("open-palette", { owner: "palette", label: "Open" });

    expect(() => {
      registry.registerAll([
        ["run-pause", { owner: "ledger", label: "Pause" }],
        ["open-palette", { owner: "ledger", label: "Open" }],
      ]);
    }).toThrow(DuplicateRegistrationError);

    // Half a family's contribution is a state no caller can reason about and none
    // unwinds, so the first entry must not have landed.
    expect(registry.has("run-pause")).toBe(false);
    expect(registry.size).toBe(1);
  });

  it("negative control: the same batch without the conflict lands whole", () => {
    // Without this, a `registerAll` that stored nothing ever would pass the case
    // above.
    const registry = throwingCommandRegistry();
    registry.registerAll([
      ["run-pause", { owner: "ledger", label: "Pause" }],
      ["open-palette", { owner: "ledger", label: "Open" }],
    ]);
    expect(registry.size).toBe(2);
  });

  it("refuses a key that appears twice inside one batch, distinctly from a repeat", () => {
    const registry = throwingCommandRegistry();
    const refusal = refusalFrom(() => {
      registry.registerAll([
        ["run-pause", { owner: "ledger", label: "Pause" }],
        ["run-pause", { owner: "ledger", label: "Pause again" }],
      ]);
    });

    expect(refusal.code).toBe("duplicate-in-batch");
    expect(refusal.key).toBe("run-pause");
  });
});

describe("KeyedRegistry — reading", () => {
  it("preserves registration order, which several callers depend on", () => {
    const registry = throwingCommandRegistry();
    registry.register("third", { owner: "a", label: "3" });
    registry.register("first", { owner: "a", label: "1" });
    registry.register("second", { owner: "a", label: "2" });

    expect(registry.keys()).toStrictEqual(["third", "first", "second"]);
    expect(registry.all().map((command) => command.label)).toStrictEqual(["3", "1", "2"]);
  });

  it("reports whether an unregister removed anything, and empties on clear", () => {
    const registry = throwingCommandRegistry();
    registry.register("boot", { owner: "frame", label: "Boot" });

    expect(registry.unregister("boot")).toBe(true);
    expect(registry.unregister("boot")).toBe(false);

    registry.register("boot", { owner: "frame", label: "Boot" });
    registry.clear();
    expect(registry.size).toBe(0);
  });
});

describe("lookupOrThrow — one wording for the missing-key defect", () => {
  const paneTitles = new Map([["timeline", "Timeline"]]);

  it("returns the value under a present key", () => {
    expect(lookupOrThrow(paneTitles, "timeline", "pane title")).toBe("Timeline");
  });

  it("throws a RangeError naming what was missing", () => {
    // A RangeError and deliberately not a console refusal: a key missing from a
    // table the caller itself populated is a defect with nowhere to render.
    expect(() => lookupOrThrow(paneTitles, "gallery", "pane title")).toThrow(RangeError);
    expect(() => lookupOrThrow(paneTitles, "gallery", "pane title")).toThrow(
      'no pane title named "gallery"',
    );
  });

  it("negative control: a present key does not throw, so the case above is not vacuous", () => {
    expect(() => lookupOrThrow(paneTitles, "timeline", "pane title")).not.toThrow();
  });
});
