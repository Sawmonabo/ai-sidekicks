// The attach form's two arms and its per-field override mark.
//
// The rule worth pinning is that an override is PRESENCE and not value inequality: a
// caller who retypes the definition's own value has still explicitly said it, and a
// form comparing strings would silently drop it from the request.

import { describe, expect, it } from "vitest";

import { AttachSidekickForm } from "./attach-model.js";

const DEFINITION = {
  definitionId: "definition-scout",
  name: "Scout",
  driverName: "claude",
  modelId: "claude-sonnet",
  effort: "high",
} as const;

describe("attach form — the union refuses exactly one shape", () => {
  it("refuses an inline arm that names neither a driver nor a model", () => {
    const form = new AttachSidekickForm();
    const readiness = form.readiness();
    expect(readiness.status).toBe("incomplete");
    expect(readiness.status === "incomplete" ? readiness.missing : []).toEqual([
      "a driver",
      "a model",
    ]);
  });

  it("accepts an inline arm naming both", () => {
    const form = new AttachSidekickForm();
    form.setField("driverName", "codex");
    form.setField("modelId", "gpt-5.6");
    const readiness = form.readiness();
    expect(readiness.status).toBe("ready");
    expect(readiness.status === "ready" ? readiness.request.driverName : undefined).toBe("codex");
  });

  it("negative control: one half alone is still incomplete", () => {
    // Without this, the case above would pass over a form that accepted anything.
    const form = new AttachSidekickForm();
    form.setField("driverName", "codex");
    expect(form.readiness().status).toBe("incomplete");
  });

  it("accepts a definition arm carrying only the id", () => {
    const form = new AttachSidekickForm();
    form.selectDefinition(DEFINITION);
    const readiness = form.readiness();
    expect(readiness.status).toBe("ready");
    expect(readiness.status === "ready" ? readiness.request.definitionId : undefined).toBe(
      "definition-scout",
    );
  });
});

describe("attach form — per-field overrides", () => {
  it("shows the definition's value until the caller edits the field", () => {
    const form = new AttachSidekickForm();
    form.selectDefinition(DEFINITION);
    expect(form.effectiveValue("modelId")).toBe("claude-sonnet");
    expect(form.isOverridden("modelId")).toBe(false);
  });

  it("marks a field the caller edited, and sends only that field", () => {
    const form = new AttachSidekickForm();
    form.selectDefinition(DEFINITION);
    form.setField("effort", "low");
    expect(form.isOverridden("effort")).toBe(true);
    const readiness = form.readiness();
    const request = readiness.status === "ready" ? readiness.request : undefined;
    expect(request?.effort).toBe("low");
    // The daemon merges per field, so an unedited axis is absent from the request
    // rather than echoed back from the definition row.
    expect(request?.modelId).toBeUndefined();
  });

  it("marks a retyped value as an override, because presence is the test", () => {
    const form = new AttachSidekickForm();
    form.selectDefinition(DEFINITION);
    form.setField("modelId", "claude-sonnet");
    expect(form.isOverridden("modelId")).toBe(true);
    const readiness = form.readiness();
    expect(readiness.status === "ready" ? readiness.request.modelId : undefined).toBe(
      "claude-sonnet",
    );
  });

  it("negative control: an untouched field is not marked", () => {
    // Without this, a form that marked everything would pass the case above.
    const form = new AttachSidekickForm();
    form.selectDefinition(DEFINITION);
    expect(form.isOverridden("driverName")).toBe(false);
  });

  it("drops every override when a different definition is chosen", () => {
    const form = new AttachSidekickForm();
    form.selectDefinition(DEFINITION);
    form.setField("effort", "low");
    form.selectDefinition({ definitionId: "definition-other" });
    expect(form.isOverridden("effort")).toBe(false);
    expect(form.effectiveValue("effort")).toBeUndefined();
  });

  it("clears an override back to the definition's own value", () => {
    const form = new AttachSidekickForm();
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
    unsubscribe();
    form.setField("modelId", "gpt-5.6");
    expect(edits).toBe(2);
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
});
