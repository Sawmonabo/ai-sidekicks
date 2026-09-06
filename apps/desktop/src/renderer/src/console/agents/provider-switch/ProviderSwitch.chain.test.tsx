// What a move CLEARS, and what an inherited axis holds back.
//
// The axes are a chain: a model belongs to one driver, an effort vocabulary is
// published per model, and a provider account belongs to one provider. So a driver
// move retires values the other fields were chosen from — and the load-bearing rule
// is that the whole RESOLVED binding is tested and not only the draft, because an
// axis the agent already runs under is just as retired by a move as one being edited.
//
// The other direction — the binding moving underneath a draft the caller is still
// editing, where the draft has to be rebased rather than dropped — is
// `ProviderSwitch.draft.test.tsx`. Which controls exist and what a press submits is
// `ProviderSwitch.controls.test.tsx`.

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AgentRosterEntry } from "../../bridge/index.js";
import type { PushDrivenReadState } from "../../seats/index.js";
import { OVERLAPPING_DRIVER_CATALOG_FIXTURE } from "../driver-catalog.test-support.js";
import type { DriverCatalogReading } from "../driver-catalog.js";
import { ProviderSwitch } from "./ProviderSwitch.js";
import {
  LOADED,
  ON_CLAUDE,
  applyActions,
  axisField,
  axisValueOf,
  chooseAxisValue,
  editProviderAccount,
  fieldLabels,
  providerAccountValue,
} from "./provider-switch.test-support.js";

describe("provider switch — a driver move clears the axes that driver governs", () => {
  it("clears the model and effort the previous driver published", () => {
    const { container } = render(
      <ProviderSwitch
        agent={{ ...ON_CLAUDE, config: { effort: "high" } }}
        catalog={LOADED}
        onApply={() => {}}
      />,
    );
    expect(axisValueOf(container, "Model")).toBe("claude-sonnet");

    chooseAxisValue(container, "Driver", "codex");

    // The previous driver's model was never in the target's catalog, and an effort
    // level is the MODEL's own vocabulary, so neither survives the move.
    expect(axisValueOf(container, "Model")).toBe("");
    expect(axisValueOf(container, "Effort")).toBe("");
  });

  it("holds both actions until a model in the target driver's catalog is named", () => {
    const { container } = render(
      <ProviderSwitch agent={ON_CLAUDE} catalog={LOADED} onApply={() => {}} />,
    );
    chooseAxisValue(container, "Driver", "codex");

    const held = applyActions(container);
    expect(held.length).toBe(2);
    expect(held.every((action) => action.disabled)).toBe(true);
    expect(container.textContent ?? "").toContain("has to name the model it moves to");
  });

  it("submits the driver AND the model once one is chosen", () => {
    // The defect: a driver move alone submitted `{ driverName }`, and an omitted
    // axis is unchanged, so the daemon validated the OLD model against the NEW
    // driver and refused the most ordinary cross-provider switch there is.
    const onApply = vi.fn();
    const { container } = render(
      <ProviderSwitch agent={ON_CLAUDE} catalog={LOADED} onApply={onApply} />,
    );
    chooseAxisValue(container, "Driver", "codex");
    chooseAxisValue(container, "Model", "gpt-5.6");

    const [deferred] = applyActions(container);
    expect(deferred?.disabled).toBe(false);
    fireEvent.click(deferred as HTMLButtonElement);
    expect(onApply).toHaveBeenCalledWith({ driverName: "codex", modelId: "gpt-5.6" }, false);
  });

  it("clears the account the source provider issued and holds the actions for one", () => {
    // The defect: the reset cleared model, effort, and speed and left the account, so
    // the field went on showing the source provider's account and a request could be
    // sent carrying nothing about it — which, since an omitted axis is unchanged and
    // accounts are provider-scoped, the daemon has to refuse.
    const { container } = render(
      <ProviderSwitch
        agent={{ ...ON_CLAUDE, config: { providerAccountId: "account-claude-1" } }}
        catalog={LOADED}
        onApply={() => {}}
      />,
    );
    expect(providerAccountValue(container)).toBe("account-claude-1");

    chooseAxisValue(container, "Driver", "codex");
    chooseAxisValue(container, "Model", "gpt-5.6");

    expect(providerAccountValue(container)).toBe("");
    const held = applyActions(container);
    expect(held.length).toBe(2);
    expect(held.every((action) => action.disabled)).toBe(true);
    expect(container.textContent ?? "").toContain("an account registered there");
  });

  it("submits the account once one of the target provider is named", () => {
    const onApply = vi.fn();
    const { container } = render(
      <ProviderSwitch
        agent={{ ...ON_CLAUDE, config: { providerAccountId: "account-claude-1" } }}
        catalog={LOADED}
        onApply={onApply}
      />,
    );
    chooseAxisValue(container, "Driver", "codex");
    chooseAxisValue(container, "Model", "gpt-5.6");
    editProviderAccount(container, "account-codex-1");

    const [deferred] = applyActions(container);
    expect(deferred?.disabled).toBe(false);
    fireEvent.click(deferred as HTMLButtonElement);
    expect(onApply).toHaveBeenCalledWith(
      { driverName: "codex", modelId: "gpt-5.6", providerAccountId: "account-codex-1" },
      false,
    );
  });

  it("negative control: a model change on the same driver keeps the account", () => {
    // Without this the cases above would pass over a form that cleared the account on
    // every edit, which would make an ordinary model change look like an account move
    // the participant never asked for.
    const onApply = vi.fn();
    const { container } = render(
      <ProviderSwitch
        agent={{ ...ON_CLAUDE, config: { providerAccountId: "account-claude-1" } }}
        catalog={LOADED}
        onApply={onApply}
      />,
    );
    chooseAxisValue(container, "Model", "claude-haiku");

    expect(providerAccountValue(container)).toBe("account-claude-1");
    const [deferred] = applyActions(container);
    expect(deferred?.disabled).toBe(false);
    fireEvent.click(deferred as HTMLButtonElement);
    expect(onApply).toHaveBeenCalledWith({ modelId: "claude-haiku" }, false);
  });

  it("negative control: an agent on no explicit account moves driver without naming one", () => {
    // An omitted account on an agent running under its provider's registered default
    // is a move the daemon resolves for itself, so holding the actions there would
    // demand a value the participant has no reason to have.
    const { container } = render(
      <ProviderSwitch agent={ON_CLAUDE} catalog={LOADED} onApply={() => {}} />,
    );
    chooseAxisValue(container, "Driver", "codex");
    chooseAxisValue(container, "Model", "gpt-5.6");

    expect(applyActions(container)[0]?.disabled).toBe(false);
    expect(container.textContent ?? "").not.toContain("an account registered there");
  });

  it("negative control: staying on the agent's own driver holds nothing back", () => {
    // Without this, the cases above would pass over a form that disabled its
    // actions for every edit, which is a different defect wearing the same green.
    const onApply = vi.fn();
    const { container } = render(
      <ProviderSwitch agent={ON_CLAUDE} catalog={LOADED} onApply={onApply} />,
    );
    chooseAxisValue(container, "Model", "claude-haiku");

    const [deferred] = applyActions(container);
    expect(deferred?.disabled).toBe(false);
    expect(container.textContent ?? "").not.toContain("has to name the model it moves to");
    fireEvent.click(deferred as HTMLButtonElement);
    expect(onApply).toHaveBeenCalledWith({ modelId: "claude-haiku" }, false);
  });

  it("drops an output speed the target driver declares no axis for", () => {
    // `codex` declares no speed vocabulary, and a dispatch against a driver that
    // declares the flag false refuses outright — so the axis is dropped rather
    // than submitted, and there is no control on screen showing it either.
    const onApply = vi.fn();
    const { container } = render(
      <ProviderSwitch agent={ON_CLAUDE} catalog={LOADED} onApply={onApply} />,
    );
    chooseAxisValue(container, "Output speed", "fast");
    chooseAxisValue(container, "Driver", "codex");
    chooseAxisValue(container, "Model", "gpt-5.6");

    fireEvent.click(applyActions(container)[0] as HTMLButtonElement);
    expect(onApply).toHaveBeenCalledWith({ driverName: "codex", modelId: "gpt-5.6" }, false);
  });

  it("negative control: the declaring driver does submit the speed it published", () => {
    // Without this, the case above would pass over a form that never submitted the
    // speed axis at all.
    const onApply = vi.fn();
    const { container } = render(
      <ProviderSwitch agent={ON_CLAUDE} catalog={LOADED} onApply={onApply} />,
    );
    chooseAxisValue(container, "Output speed", "fast");

    fireEvent.click(applyActions(container)[0] as HTMLButtonElement);
    expect(onApply).toHaveBeenCalledWith({ outputSpeed: "fast" }, false);
  });

  it("drops an effort the target model's own vocabulary does not publish", () => {
    // `claude-haiku` publishes no effort surface, so an effort chosen against its
    // sibling is not a value this model can be given.
    const onApply = vi.fn();
    const { container } = render(
      <ProviderSwitch agent={ON_CLAUDE} catalog={LOADED} onApply={onApply} />,
    );
    chooseAxisValue(container, "Effort", "low");
    chooseAxisValue(container, "Model", "claude-haiku");

    fireEvent.click(applyActions(container)[0] as HTMLButtonElement);
    expect(onApply).toHaveBeenCalledWith({ modelId: "claude-haiku" }, false);
  });
});

describe("provider switch — an inherited axis is held to the chain it lands in", () => {
  /** The overlapping reading, where two models of one driver disagree about effort. */
  const OVERLAPPING: PushDrivenReadState<DriverCatalogReading> = {
    kind: "loaded",
    value: OVERLAPPING_DRIVER_CATALOG_FIXTURE,
  };

  /** An agent whose effort is published by its current model and by only one sibling. */
  const RUNNING_HIGH: AgentRosterEntry = {
    ...ON_CLAUDE,
    modelId: "shared-model",
    config: { effort: "high" },
  };

  it("holds the actions when a model change retires the effort the agent runs under", () => {
    // The defect: only the draft was examined, so the model edit submitted alone, the
    // effort rode the request as an omission — which the contract defines as
    // unchanged — and the daemon validated `high` against a model publishing only
    // `low` and refused the switch.
    const { container } = render(
      <ProviderSwitch agent={RUNNING_HIGH} catalog={OVERLAPPING} onApply={() => {}} />,
    );
    chooseAxisValue(container, "Model", "claude-only");

    const held = applyActions(container);
    expect(held.length).toBe(2);
    expect(held.every((action) => action.disabled)).toBe(true);
    expect(container.textContent ?? "").toContain("has to name one that is");
  });

  it("marks the effort field itself, beside the reason under the actions", () => {
    const { container } = render(
      <ProviderSwitch agent={RUNNING_HIGH} catalog={OVERLAPPING} onApply={() => {}} />,
    );
    chooseAxisValue(container, "Model", "claude-only");

    expect(axisField(container, "Effort")?.textContent ?? "").toContain(
      "Not one this model publishes",
    );
  });

  it("releases the actions once a compatible effort is named, and submits it", () => {
    const onApply = vi.fn();
    const { container } = render(
      <ProviderSwitch agent={RUNNING_HIGH} catalog={OVERLAPPING} onApply={onApply} />,
    );
    chooseAxisValue(container, "Model", "claude-only");
    chooseAxisValue(container, "Effort", "low");

    const [deferred] = applyActions(container);
    expect(deferred?.disabled).toBe(false);
    fireEvent.click(deferred as HTMLButtonElement);
    expect(onApply).toHaveBeenCalledWith({ modelId: "claude-only", effort: "low" }, false);
  });

  it("negative control: a model that still publishes the agent's effort holds nothing", () => {
    // Without this, the cases above would pass over a form that held its actions for
    // every model change, which would make an ordinary edit unusable — and the
    // effort is deliberately NOT submitted here, because unchanged is what it is.
    const onApply = vi.fn();
    const { container } = render(
      <ProviderSwitch
        agent={{ ...RUNNING_HIGH, config: { effort: "low" } }}
        catalog={OVERLAPPING}
        onApply={onApply}
      />,
    );
    chooseAxisValue(container, "Model", "claude-only");

    const [deferred] = applyActions(container);
    expect(deferred?.disabled).toBe(false);
    expect(container.textContent ?? "").not.toContain("has to name one that is");
    fireEvent.click(deferred as HTMLButtonElement);
    expect(onApply).toHaveBeenCalledWith({ modelId: "claude-only" }, false);
  });

  it("negative control: an agent running under no effort at all holds nothing", () => {
    // The axis is only in question where there is an inherited value to carry.
    const { container } = render(
      <ProviderSwitch agent={ON_CLAUDE} catalog={OVERLAPPING} onApply={() => {}} />,
    );
    chooseAxisValue(container, "Model", "claude-only");
    expect(applyActions(container)[0]?.disabled).toBe(false);
  });

  it("says so plainly where the target model publishes no effort surface at all", () => {
    // No control is drawn for an absent vocabulary, so "choose a compatible level"
    // would be an instruction this form does not offer anywhere. `claude-haiku`
    // publishes none, and nothing on this surface clears an axis.
    const { container } = render(
      <ProviderSwitch
        agent={{ ...ON_CLAUDE, config: { effort: "high" } }}
        catalog={LOADED}
        onApply={() => {}}
      />,
    );
    chooseAxisValue(container, "Model", "claude-haiku");

    expect(fieldLabels(container)).not.toContain("Effort");
    expect(applyActions(container).every((action) => action.disabled)).toBe(true);
    expect(container.textContent ?? "").toContain("publishes no effort at all");
  });

  it("keeps showing the effort the agent runs under, because that is what unchanged is", () => {
    const { container } = render(
      <ProviderSwitch agent={RUNNING_HIGH} catalog={OVERLAPPING} onApply={() => {}} />,
    );
    expect(axisValueOf(container, "Effort")).toBe("high");
    chooseAxisValue(container, "Model", "claude-only");
    expect(axisValueOf(container, "Effort")).toBe("high");
  });
});
