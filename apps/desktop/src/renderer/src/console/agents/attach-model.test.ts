// The attach form's two arms, its per-field override mark, and its field chain.
//
// The rule worth pinning is that an override is PRESENCE and not value inequality: a
// caller who retypes the definition's own value has still explicitly said it, and a
// form comparing strings would silently drop it from the request.
//
// The second rule, and the one a permissive fixture hides, is that BOTH arms compose
// the registered request or neither does: a request without a session and a name is
// refused by any conforming daemon whatever else it carries.
//
// The third is that the fields are a CHAIN. A model belongs to one driver and an
// effort vocabulary is published per model, so choosing a driver after a model
// retires the vocabulary the other fields were chosen from. The last suite drives
// that against a catalog built for it, because the shared fixture deliberately keeps
// its two drivers apart and the interesting cases are the overlaps.

import { describe, expect, it } from "vitest";

import { AttachSidekickForm, type AttachRequest } from "./attach-model.js";
import {
  DRIVER_CATALOG_FIXTURE,
  OVERLAPPING_DRIVER_CATALOG_FIXTURE,
} from "./driver-catalog.test-support.js";
import type { DriverCatalogReading } from "./driver-catalog.js";

const SESSION_ID = "session-9";

/**
 * The two members the registered request base requires of BOTH arms.
 *
 * Declared here because the contract package carries the payload interfaces as
 * documentation rather than as exported types, so this is as close to the registered
 * shape as a compile-time check gets — and it is exactly the half that was missing.
 */
interface RegisteredAttachRequiredMembers {
  readonly sessionId: string;
  readonly name: string;
}

/** Compiles only while a composed request carries both of them. */
function requiredMembersOf(request: AttachRequest): RegisteredAttachRequiredMembers {
  return request;
}

const DEFINITION = {
  definitionId: "definition-scout",
  name: "Scout",
  driverName: "claude",
  modelId: "claude-sonnet",
  effort: "high",
} as const;

/** A form that already carries the agent name both arms require. */
function namedForm(name = "Scout"): AttachSidekickForm {
  const form = new AttachSidekickForm();
  form.setName(name);
  return form;
}

describe("attach form — the union refuses exactly one shape", () => {
  it("refuses an inline arm that names neither a driver nor a model", () => {
    const form = namedForm();
    const readiness = form.readiness(SESSION_ID, DRIVER_CATALOG_FIXTURE);
    expect(readiness.status).toBe("incomplete");
    expect(readiness.status === "incomplete" ? readiness.missing : []).toEqual([
      "a driver",
      "a model",
    ]);
  });

  it("accepts an inline arm naming both", () => {
    const form = namedForm();
    form.setField("driverName", "codex", DRIVER_CATALOG_FIXTURE);
    form.setField("modelId", "gpt-5.6", DRIVER_CATALOG_FIXTURE);
    const readiness = form.readiness(SESSION_ID, DRIVER_CATALOG_FIXTURE);
    expect(readiness.status).toBe("ready");
    expect(readiness.status === "ready" ? readiness.request.driverName : undefined).toBe("codex");
  });

  it("negative control: one half alone is still incomplete", () => {
    // Without this, the case above would pass over a form that accepted anything.
    const form = namedForm();
    form.setField("driverName", "codex", DRIVER_CATALOG_FIXTURE);
    expect(form.readiness(SESSION_ID, DRIVER_CATALOG_FIXTURE).status).toBe("incomplete");
  });

  it("accepts a definition arm carrying only the id", () => {
    const form = namedForm();
    form.selectDefinition(DEFINITION);
    const readiness = form.readiness(SESSION_ID, DRIVER_CATALOG_FIXTURE);
    expect(readiness.status).toBe("ready");
    expect(readiness.status === "ready" ? readiness.request.definitionId : undefined).toBe(
      "definition-scout",
    );
  });
});

describe("attach form — the session and the name the registered base requires", () => {
  it("binds the session the caller supplies rather than one it holds", () => {
    const form = namedForm();
    form.setField("driverName", "codex", DRIVER_CATALOG_FIXTURE);
    form.setField("modelId", "gpt-5.6", DRIVER_CATALOG_FIXTURE);
    const readiness = form.readiness("session-elsewhere", DRIVER_CATALOG_FIXTURE);
    expect(readiness.status === "ready" ? readiness.request.sessionId : undefined).toBe(
      "session-elsewhere",
    );
  });

  it("composes an inline request carrying exactly the four members it should", () => {
    const form = namedForm();
    form.setField("driverName", "codex", DRIVER_CATALOG_FIXTURE);
    form.setField("modelId", "gpt-5.6", DRIVER_CATALOG_FIXTURE);
    const readiness = form.readiness(SESSION_ID, DRIVER_CATALOG_FIXTURE);
    expect(readiness.status === "ready" ? readiness.request : undefined).toEqual({
      sessionId: SESSION_ID,
      name: "Scout",
      driverName: "codex",
      modelId: "gpt-5.6",
      providerAccountId: undefined,
      effort: undefined,
    });
  });

  it("composes a definition request carrying the id and only the entered overrides", () => {
    const form = namedForm("Reviewer");
    form.selectDefinition(DEFINITION);
    form.setField("effort", "low", DRIVER_CATALOG_FIXTURE);
    const readiness = form.readiness(SESSION_ID, DRIVER_CATALOG_FIXTURE);
    expect(readiness.status === "ready" ? readiness.request : undefined).toEqual({
      sessionId: SESSION_ID,
      name: "Reviewer",
      definitionId: "definition-scout",
      driverName: undefined,
      modelId: undefined,
      providerAccountId: undefined,
      effort: "low",
    });
  });

  it("carries the two required members at the type level, not only at runtime", () => {
    const form = namedForm();
    form.setField("driverName", "codex", DRIVER_CATALOG_FIXTURE);
    form.setField("modelId", "gpt-5.6", DRIVER_CATALOG_FIXTURE);
    const readiness = form.readiness(SESSION_ID, DRIVER_CATALOG_FIXTURE);
    expect(readiness.status).toBe("ready");
    if (readiness.status !== "ready") {
      return;
    }
    // The call is the assertion: it does not compile while `AttachRequest` leaves
    // either member optional, which is the state the permissive fixture accepted.
    expect(requiredMembersOf(readiness.request)).toMatchObject({
      sessionId: SESSION_ID,
      name: "Scout",
    });
  });

  it("negative control: an unnamed form is incomplete on the inline arm", () => {
    // The pre-fix form reported `ready` here and composed a request carrying
    // neither member, which a conforming daemon refuses.
    const form = new AttachSidekickForm();
    form.setField("driverName", "codex", DRIVER_CATALOG_FIXTURE);
    form.setField("modelId", "gpt-5.6", DRIVER_CATALOG_FIXTURE);
    const readiness = form.readiness(SESSION_ID, DRIVER_CATALOG_FIXTURE);
    expect(readiness.status).toBe("incomplete");
    expect(readiness.status === "incomplete" ? readiness.missing : []).toEqual(["a name"]);
  });

  it("negative control: an unnamed form is incomplete on the definition arm too", () => {
    // The same defect on the arm that needs nothing else: the id alone was ready.
    const form = new AttachSidekickForm();
    form.selectDefinition(DEFINITION);
    const readiness = form.readiness(SESSION_ID, DRIVER_CATALOG_FIXTURE);
    expect(readiness.status).toBe("incomplete");
    expect(readiness.status === "incomplete" ? readiness.missing : []).toEqual(["a name"]);
  });

  it("treats whitespace as no name at all rather than sending it", () => {
    const form = namedForm("   ");
    form.selectDefinition(DEFINITION);
    expect(form.readiness(SESSION_ID, DRIVER_CATALOG_FIXTURE).status).toBe("incomplete");
  });

  it("never fills the name in from the definition the caller chose", () => {
    // The definition's name is the DEFINITION's. A form that copied it would be
    // asserting a choice nobody made, and this one is chosen deliberately because
    // the fixture definition carries a name.
    const form = new AttachSidekickForm();
    form.selectDefinition(DEFINITION);
    expect(form.name).toBe("");
  });
});

describe("attach form — per-field overrides", () => {
  it("shows the definition's value until the caller edits the field", () => {
    const form = namedForm();
    form.selectDefinition(DEFINITION);
    expect(form.effectiveValue("modelId")).toBe("claude-sonnet");
    expect(form.isOverridden("modelId")).toBe(false);
  });

  it("marks a field the caller edited, and sends only that field", () => {
    const form = namedForm();
    form.selectDefinition(DEFINITION);
    form.setField("effort", "low", DRIVER_CATALOG_FIXTURE);
    expect(form.isOverridden("effort")).toBe(true);
    const readiness = form.readiness(SESSION_ID, DRIVER_CATALOG_FIXTURE);
    const request = readiness.status === "ready" ? readiness.request : undefined;
    expect(request?.effort).toBe("low");
    // The daemon merges per field, so an unedited axis is absent from the request
    // rather than echoed back from the definition row.
    expect(request?.modelId).toBeUndefined();
  });

  it("marks a retyped value as an override, because presence is the test", () => {
    const form = namedForm();
    form.selectDefinition(DEFINITION);
    form.setField("modelId", "claude-sonnet", DRIVER_CATALOG_FIXTURE);
    expect(form.isOverridden("modelId")).toBe(true);
    const readiness = form.readiness(SESSION_ID, DRIVER_CATALOG_FIXTURE);
    expect(readiness.status === "ready" ? readiness.request.modelId : undefined).toBe(
      "claude-sonnet",
    );
  });

  it("negative control: an untouched field is not marked", () => {
    // Without this, a form that marked everything would pass the case above.
    const form = namedForm();
    form.selectDefinition(DEFINITION);
    expect(form.isOverridden("driverName")).toBe(false);
  });

  it("drops every override when a different definition is chosen", () => {
    const form = namedForm();
    form.selectDefinition(DEFINITION);
    form.setField("effort", "low", DRIVER_CATALOG_FIXTURE);
    form.selectDefinition({ definitionId: "definition-other" });
    expect(form.isOverridden("effort")).toBe(false);
    expect(form.effectiveValue("effort")).toBeUndefined();
  });

  it("keeps the name across a change of definition, because it is nobody's override", () => {
    const form = namedForm("Reviewer");
    form.selectDefinition(DEFINITION);
    form.selectDefinition({ definitionId: "definition-other" });
    expect(form.name).toBe("Reviewer");
  });

  it("clears an override back to the definition's own value", () => {
    const form = namedForm();
    form.selectDefinition(DEFINITION);
    form.setField("effort", "low", DRIVER_CATALOG_FIXTURE);
    form.clearOverride("effort");
    expect(form.effectiveValue("effort")).toBe("high");
  });
});

describe("attach form — notification", () => {
  it("notifies on every edit, so a render sees it", () => {
    const form = new AttachSidekickForm();
    let edits = 0;
    const unsubscribe = form.onChange(() => {
      edits += 1;
    });
    form.setField("driverName", "codex", DRIVER_CATALOG_FIXTURE);
    form.selectArm("definition");
    form.setName("Scout");
    unsubscribe();
    form.setField("modelId", "gpt-5.6", DRIVER_CATALOG_FIXTURE);
    expect(edits).toBe(3);
  });

  it("negative control: selecting the arm already selected notifies nobody", () => {
    const form = new AttachSidekickForm();
    let edits = 0;
    form.onChange(() => {
      edits += 1;
    });
    form.selectArm("inline");
    expect(edits).toBe(0);
  });

  it("negative control: retyping the name it already has notifies nobody", () => {
    const form = namedForm();
    let edits = 0;
    form.onChange(() => {
      edits += 1;
    });
    form.setName("Scout");
    expect(edits).toBe(0);
  });
});

/**
 * The overlapping reading, taken from the family fixture rather than built here.
 *
 * `DRIVER_CATALOG_FIXTURE`'s two drivers share no model id at all, which makes it the
 * right fixture for the axis controls and the wrong one for a chain, where the whole
 * question is what survives a change of driver or model.
 */
const OVERLAPPING_CATALOG: DriverCatalogReading = OVERLAPPING_DRIVER_CATALOG_FIXTURE;

/** An inline form filled top-down, the order a person fills the dialog in. */
function inlineFormOver(
  catalog: DriverCatalogReading,
  entries: Partial<Record<"driverName" | "modelId" | "effort" | "providerAccountId", string>>,
): AttachSidekickForm {
  const form = namedForm();
  for (const field of ["driverName", "modelId", "effort", "providerAccountId"] as const) {
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
