// The refusal a repeat raises under each policy that refuses one. Refusals are asserted on `code`,
// which a catch site branches on, not on message prose that may be reworded.

import { describe, expect, it } from "vitest";
import { DuplicateRegistrationError, KeyedRegistry } from "./keyed-registry.js";
import type { Refusal } from "./refusal/contract.js";

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

function ownerScopedScreenRegistry(): KeyedRegistry<string, OwnedCommand> {
  return new KeyedRegistry<string, OwnedCommand>({
    duplicatePolicy: "owner-scoped",
    describeWhat: "screen",
    ownerOf: (command) => command.owner,
  });
}

interface RefusedRegistration extends Refusal {
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

describe("KeyedRegistry — the throw policy", () => {
  it("refuses a repeat, naming the key and the refusal code, and keeps the first value", () => {
    const registry = throwingCommandRegistry();
    registry.register("open-palette", { owner: "palette", label: "Open" });

    const refusal = refusalFrom(() => {
      registry.register("open-palette", { owner: "frame", label: "Also open" });
    });

    expect(refusal.code).toBe("duplicate-registration");
    expect(refusal.origin).toBe("keyed-registry");
    expect(refusal.key).toBe("open-palette");
    expect(refusal.detail).toContain("command");
    // The first value stays, so behavior does not depend on module import order.
    expect(registry.get("open-palette")?.owner).toBe("palette");
  });
});

describe("KeyedRegistry — the owner-scoped policy", () => {
  it("refuses a different owner, naming both parties", () => {
    const registry = ownerScopedScreenRegistry();
    registry.register("transcript", { owner: "transcript", label: "Transcript" });

    const refusal = refusalFrom(() => {
      registry.register("transcript", { owner: "workflows", label: "Workflow" });
    });

    expect(refusal.code).toBe("owner-conflict");
    expect(refusal.detail).toContain("transcript");
    expect(refusal.detail).toContain("workflows");
  });
});
