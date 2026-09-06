// The attach form's fields as a chain, and the membership test readiness performs.
//
// A model belongs to one driver and an effort vocabulary is published per model, so
// choosing a driver after a model retires the vocabulary the other fields were chosen
// from. These cases drive that against a catalog built for it, because the shared
// fixture deliberately keeps its two drivers apart and the interesting cases are the
// overlaps.
//
// Readiness is here rather than beside the request, for the same reason: what it
// tests is MEMBERSHIP in the published vocabulary and not presence of a value, so a
// form nobody touched can stop being ready when the catalog moves under it.
//
// What the form composes once it is ready is `attach-model.request.test.ts`.

import { describe, expect, it } from "vitest";

import {
  DRIVER_CATALOG_FIXTURE,
  OVERLAPPING_DRIVER_CATALOG_FIXTURE,
} from "../driver-catalog.test-support.js";
import type { DriverCatalogReading } from "../driver-catalog.js";
import { AttachSidekickForm } from "./attach-model.js";
import { ATTACH_FIELDS, type AttachField } from "./attach-readiness.js";
import { DEFINITION, SESSION_ID, namedForm } from "./attach-model.test-support.js";

/**
 * The overlapping reading, taken from the family fixture rather than built here.
 *
 * `DRIVER_CATALOG_FIXTURE`'s two drivers share no model id at all, which makes it the
 * right fixture for the axis controls and the wrong one for a chain, where the whole
 * question is what survives a change of driver or model.
 */
const OVERLAPPING_CATALOG: DriverCatalogReading = OVERLAPPING_DRIVER_CATALOG_FIXTURE;

/**
 * An inline form filled parent-first, over the field set the model itself declares.
 *
 * Iterating {@link ATTACH_FIELDS} rather than a literal written out here is what makes
 * an axis added to the wire reach this suite: a sixth axis joins every case's fill
 * automatically, and a case that names one in `entries` is checked against the real
 * union rather than against a copy of it that stopped matching. The declaration order
 * lists a parent before its child, which is the order these cases depend on.
 */
function inlineFormOver(
  catalog: DriverCatalogReading,
  entries: Partial<Record<AttachField, string>>,
): AttachSidekickForm {
  const form = namedForm();
  for (const field of ATTACH_FIELDS) {
    const value = entries[field];
    if (value !== undefined) {
      form.setField(field, value, catalog);
    }
  }
  return form;
}

describe("attach form — the fields are a chain", () => {
  it("drops the model, the effort, and the account a new driver retires", () => {
    const form = inlineFormOver(OVERLAPPING_CATALOG, {
      driverName: "claude",
      modelId: "claude-only",
      effort: "low",
      providerAccountId: "account-7",
    });
    form.setField("driverName", "codex", OVERLAPPING_CATALOG);
    expect(form.effectiveValue("driverName")).toBe("codex");
    expect(form.effectiveValue("modelId")).toBeUndefined();
    expect(form.effectiveValue("effort")).toBeUndefined();
    expect(form.effectiveValue("providerAccountId")).toBeUndefined();
  });

  it("negative control: all four were entered before the driver moved", () => {
    // Without this the case above would pass over a form that never held them, and
    // would be measuring `setField` rather than the chain.
    const form = inlineFormOver(OVERLAPPING_CATALOG, {
      driverName: "claude",
      modelId: "claude-only",
      effort: "low",
      providerAccountId: "account-7",
    });
    expect(form.effectiveValue("modelId")).toBe("claude-only");
    expect(form.effectiveValue("effort")).toBe("low");
    expect(form.effectiveValue("providerAccountId")).toBe("account-7");
  });

  it("keeps a model id the new driver also carries, and an effort it still publishes", () => {
    const form = inlineFormOver(OVERLAPPING_CATALOG, {
      driverName: "claude",
      modelId: "shared-model",
      effort: "low",
    });
    form.setField("driverName", "codex", OVERLAPPING_CATALOG);
    expect(form.effectiveValue("modelId")).toBe("shared-model");
    expect(form.effectiveValue("effort")).toBe("low");
  });

  it("drops an effort the surviving model no longer publishes under the new driver", () => {
    // The model survives and the level does not: `high` is `claude`'s reading of
    // `shared-model`, and `codex` publishes only `low` for the same id.
    const form = inlineFormOver(OVERLAPPING_CATALOG, {
      driverName: "claude",
      modelId: "shared-model",
      effort: "high",
    });
    form.setField("driverName", "codex", OVERLAPPING_CATALOG);
    expect(form.effectiveValue("modelId")).toBe("shared-model");
    expect(form.effectiveValue("effort")).toBeUndefined();
  });

  it("drops an effort the newly chosen model does not publish", () => {
    const form = inlineFormOver(OVERLAPPING_CATALOG, {
      driverName: "claude",
      modelId: "shared-model",
      effort: "high",
    });
    form.setField("modelId", "claude-only", OVERLAPPING_CATALOG);
    expect(form.effectiveValue("effort")).toBeUndefined();
  });

  it("keeps an effort the newly chosen model still publishes", () => {
    // Without this pair the rule would be indistinguishable from "a model change
    // clears the effort", which would throw away a choice the catalog still vouches
    // for and make the axis unusable on any form filled out of order.
    const form = inlineFormOver(OVERLAPPING_CATALOG, {
      driverName: "claude",
      modelId: "shared-model",
      effort: "low",
    });
    form.setField("modelId", "claude-only", OVERLAPPING_CATALOG);
    expect(form.effectiveValue("effort")).toBe("low");
  });

  it("keeps the provider account when only the model moves", () => {
    // The account is dropped by a DRIVER change, because an account is
    // provider-scoped. A model change within one driver retires nothing about it.
    const form = inlineFormOver(OVERLAPPING_CATALOG, {
      driverName: "claude",
      modelId: "shared-model",
      providerAccountId: "account-7",
    });
    form.setField("modelId", "claude-only", OVERLAPPING_CATALOG);
    expect(form.effectiveValue("providerAccountId")).toBe("account-7");
  });

  it("drops the account even where the model survives the driver change", () => {
    // No read this console has says which provider an account belongs to, so there
    // is no vocabulary that could vouch for it — dropping is unconditional.
    const form = inlineFormOver(OVERLAPPING_CATALOG, {
      driverName: "claude",
      modelId: "shared-model",
      providerAccountId: "account-7",
    });
    form.setField("driverName", "codex", OVERLAPPING_CATALOG);
    expect(form.effectiveValue("modelId")).toBe("shared-model");
    expect(form.effectiveValue("providerAccountId")).toBeUndefined();
  });
});

describe("attach form — readiness tests membership, never presence", () => {
  it("refuses a model the catalog retired under a form nobody touched", () => {
    // The chain in `setField` cannot be the only guard: a catalog refresh can retire
    // a model while the form sits open, and the entry left behind is still present.
    const form = inlineFormOver(OVERLAPPING_CATALOG, {
      driverName: "claude",
      modelId: "claude-only",
    });
    const readiness = form.readiness(SESSION_ID, DRIVER_CATALOG_FIXTURE);
    expect(readiness.status).toBe("incomplete");
    expect(readiness.status === "incomplete" ? readiness.missing : []).toContain(
      "a model this driver carries",
    );
  });

  it("negative control: the same form is ready against the catalog it was filled from", () => {
    // Without this the case above would pass over a form that refused everything.
    const form = inlineFormOver(OVERLAPPING_CATALOG, {
      driverName: "claude",
      modelId: "claude-only",
    });
    expect(form.readiness(SESSION_ID, OVERLAPPING_CATALOG).status).toBe("ready");
  });

  it("reads rather than mutates: the refused entry is still the one the form shows", () => {
    // A readiness check that quietly cleared what it refused would empty a field
    // under the caller's cursor, and the form would report a state nobody chose.
    const form = inlineFormOver(OVERLAPPING_CATALOG, {
      driverName: "claude",
      modelId: "claude-only",
    });
    form.readiness(SESSION_ID, DRIVER_CATALOG_FIXTURE);
    expect(form.effectiveValue("modelId")).toBe("claude-only");
  });

  it("refuses a driver no catalog carries", () => {
    const form = inlineFormOver(OVERLAPPING_CATALOG, {
      driverName: "claude",
      modelId: "shared-model",
    });
    form.setField("driverName", "gemini", OVERLAPPING_CATALOG);
    const readiness = form.readiness(SESSION_ID, OVERLAPPING_CATALOG);
    expect(readiness.status).toBe("incomplete");
    expect(readiness.status === "incomplete" ? readiness.missing : []).toContain(
      "a driver this catalog carries",
    );
  });

  it("refuses an effort the selected model does not publish", () => {
    // Reachable without any catalog move: `setField` re-tests the effort when its
    // PARENT moves, and typing a level the model never published moves no parent.
    const form = inlineFormOver(OVERLAPPING_CATALOG, {
      driverName: "codex",
      modelId: "shared-model",
      effort: "high",
    });
    const readiness = form.readiness(SESSION_ID, OVERLAPPING_CATALOG);
    expect(readiness.status).toBe("incomplete");
    expect(readiness.status === "incomplete" ? readiness.missing : []).toContain(
      "an effort this model carries",
    );
  });

  it("names the unread catalog rather than treating it as permission", () => {
    // An entered axis and nothing to vouch for it fails CLOSED, and says which read
    // is missing rather than reporting a driver the catalog never refused.
    const form = inlineFormOver(OVERLAPPING_CATALOG, {
      driverName: "claude",
      modelId: "shared-model",
    });
    const readiness = form.readiness(SESSION_ID, undefined);
    expect(readiness.status).toBe("incomplete");
    expect(readiness.status === "incomplete" ? readiness.missing : []).toEqual([
      "the model catalog",
    ]);
  });

  it("stays submittable on the definition arm while the catalog read is in flight", () => {
    // The daemon resolves a definition's own driver and model itself, so a form
    // carrying no entered axis needs no catalog — which is what keeps the arm the
    // column's own suite drives usable before the read lands.
    const form = namedForm();
    form.selectDefinition(DEFINITION);
    expect(form.readiness(SESSION_ID, undefined).status).toBe("ready");
  });

  it("holds the definition arm to the same membership test once an axis is entered", () => {
    // An override is an entered axis like any other: the arm resolves the rest, and
    // the one field the caller typed still has to be one the catalog carries.
    const form = namedForm();
    form.selectDefinition(DEFINITION);
    form.setField("modelId", "model-that-left", DRIVER_CATALOG_FIXTURE);
    const readiness = form.readiness(SESSION_ID, DRIVER_CATALOG_FIXTURE);
    expect(readiness.status).toBe("incomplete");
    expect(readiness.status === "incomplete" ? readiness.missing : []).toContain(
      "a model this driver carries",
    );
  });
});

describe("attach form — an override is validated against the chain it lands in", () => {
  /** The definition the overlapping catalog vouches for as a whole. */
  const OVERLAPPING_DEFINITION = {
    definitionId: "definition-shared",
    name: "Shared",
    driverName: "claude",
    modelId: "shared-model",
    effort: "high",
  } as const;

  it("refuses an inherited model the overridden driver does not carry", () => {
    // The defect: only the entered driver was examined, so the definition's own
    // model and effort stayed valid on the form and the daemon merged them into a
    // provider that publishes neither.
    const form = namedForm();
    form.selectDefinition({ ...OVERLAPPING_DEFINITION, modelId: "claude-only" });
    form.setField("driverName", "codex", OVERLAPPING_CATALOG);
    const readiness = form.readiness(SESSION_ID, OVERLAPPING_CATALOG);
    expect(readiness.status).toBe("incomplete");
    expect(readiness.status === "incomplete" ? readiness.missing : []).toContain(
      "a model this driver carries",
    );
  });

  it("refuses an inherited effort the overridden driver's reading of the model retires", () => {
    // The model SURVIVES the override — both drivers carry `shared-model` — and only
    // the effort does not, which is the case an entered-only check cannot see at all.
    const form = namedForm();
    form.selectDefinition(OVERLAPPING_DEFINITION);
    form.setField("driverName", "codex", OVERLAPPING_CATALOG);
    const readiness = form.readiness(SESSION_ID, OVERLAPPING_CATALOG);
    expect(readiness.status).toBe("incomplete");
    expect(readiness.status === "incomplete" ? readiness.missing : []).toEqual([
      "an effort this model carries",
    ]);
  });

  it("leaves the inherited axis showing, so the caller overrides what they can see", () => {
    // An inherited axis is the DEFINITION's: clearing it here would edit a row the
    // caller never chose to edit, and empty a field under their cursor.
    const form = namedForm();
    form.selectDefinition(OVERLAPPING_DEFINITION);
    form.setField("driverName", "codex", OVERLAPPING_CATALOG);
    expect(form.effectiveValue("effort")).toBe("high");
    expect(form.isOverridden("effort")).toBe(false);
  });

  it("becomes ready once the incompatible axis is overridden with a compatible value", () => {
    const form = namedForm();
    form.selectDefinition(OVERLAPPING_DEFINITION);
    form.setField("driverName", "codex", OVERLAPPING_CATALOG);
    form.setField("effort", "low", OVERLAPPING_CATALOG);
    const readiness = form.readiness(SESSION_ID, OVERLAPPING_CATALOG);
    expect(readiness.status).toBe("ready");
    expect(readiness.status === "ready" ? readiness.request : undefined).toEqual({
      sessionId: SESSION_ID,
      name: "Scout",
      definitionId: "definition-shared",
      driverName: "codex",
      modelId: undefined,
      providerAccountId: undefined,
      effort: "low",
    });
  });

  it("negative control: an override the whole inherited chain survives stays ready", () => {
    // Without this the cases above would pass over a form that refused every
    // definition arm carrying an override, which is a different defect wearing the
    // same green: `claude-only` is `claude`'s own model and publishes `low`.
    const form = namedForm();
    form.selectDefinition({ ...OVERLAPPING_DEFINITION, effort: "low" });
    form.setField("modelId", "claude-only", OVERLAPPING_CATALOG);
    expect(form.readiness(SESSION_ID, OVERLAPPING_CATALOG).status).toBe("ready");
  });

  it("negative control: the untouched definition arm needs no catalog and no chain", () => {
    // The whole chain is only in question once something is entered. A definition
    // resolves coherently at the daemon, so an arm carrying no override stays
    // submittable even while the catalog read is in flight.
    const form = namedForm();
    form.selectDefinition({ ...OVERLAPPING_DEFINITION, modelId: "claude-only" });
    expect(form.readiness(SESSION_ID, OVERLAPPING_CATALOG).status).toBe("ready");
    expect(form.readiness(SESSION_ID, undefined).status).toBe("ready");
  });
});
