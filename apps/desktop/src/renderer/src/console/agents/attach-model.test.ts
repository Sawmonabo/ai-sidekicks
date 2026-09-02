// The attach form's two arms and its per-field override mark.
//
// The rule worth pinning is that an override is PRESENCE and not value inequality: a
// caller who retypes the definition's own value has still explicitly said it, and a
// form comparing strings would silently drop it from the request.
//
// The second rule, and the one a permissive fixture hides, is that BOTH arms compose
// the registered request or neither does: a request without a session and a name is
// refused by any conforming daemon whatever else it carries.

import { describe, expect, it } from "vitest";

import { AttachSidekickForm, type AttachRequest } from "./attach-model.js";

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
    const readiness = form.readiness(SESSION_ID);
    expect(readiness.status).toBe("incomplete");
    expect(readiness.status === "incomplete" ? readiness.missing : []).toEqual([
      "a driver",
      "a model",
    ]);
  });

  it("accepts an inline arm naming both", () => {
    const form = namedForm();
    form.setField("driverName", "codex");
    form.setField("modelId", "gpt-5.6");
    const readiness = form.readiness(SESSION_ID);
    expect(readiness.status).toBe("ready");
    expect(readiness.status === "ready" ? readiness.request.driverName : undefined).toBe("codex");
  });

  it("negative control: one half alone is still incomplete", () => {
    // Without this, the case above would pass over a form that accepted anything.
    const form = namedForm();
    form.setField("driverName", "codex");
    expect(form.readiness(SESSION_ID).status).toBe("incomplete");
  });

  it("accepts a definition arm carrying only the id", () => {
    const form = namedForm();
    form.selectDefinition(DEFINITION);
    const readiness = form.readiness(SESSION_ID);
    expect(readiness.status).toBe("ready");
    expect(readiness.status === "ready" ? readiness.request.definitionId : undefined).toBe(
      "definition-scout",
    );
  });
});

describe("attach form — the session and the name the registered base requires", () => {
  it("binds the session the caller supplies rather than one it holds", () => {
    const form = namedForm();
    form.setField("driverName", "codex");
    form.setField("modelId", "gpt-5.6");
    const readiness = form.readiness("session-elsewhere");
    expect(readiness.status === "ready" ? readiness.request.sessionId : undefined).toBe(
      "session-elsewhere",
    );
  });

  it("composes an inline request carrying exactly the four members it should", () => {
    const form = namedForm();
    form.setField("driverName", "codex");
    form.setField("modelId", "gpt-5.6");
    const readiness = form.readiness(SESSION_ID);
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
    form.setField("effort", "low");
    const readiness = form.readiness(SESSION_ID);
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
    form.setField("driverName", "codex");
    form.setField("modelId", "gpt-5.6");
    const readiness = form.readiness(SESSION_ID);
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
    form.setField("driverName", "codex");
    form.setField("modelId", "gpt-5.6");
    const readiness = form.readiness(SESSION_ID);
    expect(readiness.status).toBe("incomplete");
    expect(readiness.status === "incomplete" ? readiness.missing : []).toEqual(["a name"]);
  });

  it("negative control: an unnamed form is incomplete on the definition arm too", () => {
    // The same defect on the arm that needs nothing else: the id alone was ready.
    const form = new AttachSidekickForm();
    form.selectDefinition(DEFINITION);
    const readiness = form.readiness(SESSION_ID);
    expect(readiness.status).toBe("incomplete");
    expect(readiness.status === "incomplete" ? readiness.missing : []).toEqual(["a name"]);
  });

  it("treats whitespace as no name at all rather than sending it", () => {
    const form = namedForm("   ");
    form.selectDefinition(DEFINITION);
    expect(form.readiness(SESSION_ID).status).toBe("incomplete");
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
    form.setField("effort", "low");
    expect(form.isOverridden("effort")).toBe(true);
    const readiness = form.readiness(SESSION_ID);
    const request = readiness.status === "ready" ? readiness.request : undefined;
    expect(request?.effort).toBe("low");
    // The daemon merges per field, so an unedited axis is absent from the request
    // rather than echoed back from the definition row.
    expect(request?.modelId).toBeUndefined();
  });

  it("marks a retyped value as an override, because presence is the test", () => {
    const form = namedForm();
    form.selectDefinition(DEFINITION);
    form.setField("modelId", "claude-sonnet");
    expect(form.isOverridden("modelId")).toBe(true);
    const readiness = form.readiness(SESSION_ID);
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
    form.setField("effort", "low");
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
    form.setField("effort", "low");
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
    form.setField("driverName", "codex");
    form.selectArm("definition");
    form.setName("Scout");
    unsubscribe();
    form.setField("modelId", "gpt-5.6");
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
