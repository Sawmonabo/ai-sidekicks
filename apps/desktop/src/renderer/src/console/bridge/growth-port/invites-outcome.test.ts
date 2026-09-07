// The one thing a derived type can fail at silently: resolving to `never`.
//
// `ServedInvite` is `Extract<…, {status: "served"}>["value"][number]`. Narrow the
// `invitesList` growth signature so the served value is an object rather than a bare
// array and that index resolves to `never` — every member access on it errors, but a
// module that only PASSES the row around still compiles, and the type has quietly
// stopped describing anything. That was two independent failures while two families
// each declared their own; it is one now, and this pins it.

import { describe, expect, it } from "vitest";

import { growthUnavailable } from "./growth-refusals.js";
import type { InvitesListRefusal, ServedInvite } from "./invites-outcome.js";

/** `false` exactly when `T` is uninhabited. A derived row type never should be. */
type IsInhabited<T> = [T] extends [never] ? false : true;

describe("the invites outcome derivation", () => {
  it("resolves the served row to an inhabited type", () => {
    const servedRowIsInhabited: IsInhabited<ServedInvite> = true;

    expect(servedRowIsInhabited).toBe(true);
  });

  it("would report an uninhabited row rather than pass it along", () => {
    // The negative control. `never` is what the index resolves to the day the
    // served value stops being a bare array, and the assignment below is the shape
    // the case above would take on that day.
    // @ts-expect-error `IsInhabited<never>` is `false`, so `true` does not fit.
    const uninhabited: IsInhabited<never> = true;

    expect(uninhabited).toBe(true);
  });

  it("narrows the port's own refusal onto the refusal arm", () => {
    const refusal: InvitesListRefusal = growthUnavailable("invitesList");

    expect(refusal.status).toBe("unavailable");
    expect(refusal.operationId).toBe("invitesList");
  });
});
