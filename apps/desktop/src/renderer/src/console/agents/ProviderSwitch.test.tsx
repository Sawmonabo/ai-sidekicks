// Which controls exist, and what the two apply actions actually submit.
//
// The load-bearing case is the one where a capability is NOT declared: the control
// is absent, never disabled, because a disabled control asserts that the operation
// exists and is momentarily unavailable — and the daemon would refuse it outright.

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { refuse } from "../core/index.js";
import { ProviderSwitch } from "./ProviderSwitch.js";
import {
  DRIVER_CATALOG_FIXTURE,
  OVERLAPPING_DRIVER_CATALOG_FIXTURE,
} from "./driver-catalog-fixtures.js";
import type { AgentRosterEntry } from "./agent-wire.js";
import type { DriverCatalogReading } from "./driver-catalog.js";
import type { PushDrivenReadState } from "../seats/index.js";

const LOADED: PushDrivenReadState<DriverCatalogReading> = {
  kind: "loaded",
  value: DRIVER_CATALOG_FIXTURE,
};

const ON_CLAUDE: AgentRosterEntry = {
  agentId: "agent-scout",
  name: "Scout",
  state: "ready",
  driverName: "claude",
  modelId: "claude-sonnet",
};

const ON_CODEX: AgentRosterEntry = { ...ON_CLAUDE, driverName: "codex", modelId: "gpt-5.6" };

function fieldLabels(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".meridian-axis-field__label")].map(
    (element) => element.textContent ?? "",
  );
}

/** What the account field currently shows, which is the draft's answer for that axis. */
function providerAccountValue(container: HTMLElement): string {
  const input = container.querySelector(".meridian-axis-field__text") as HTMLInputElement | null;
  return input?.value ?? "";
}

/** Edits one axis through the plain text input, which needs no popup to open. */
function editProviderAccount(container: HTMLElement, value: string): void {
  const input = container.querySelector(".meridian-axis-field__text");
  fireEvent.change(input as HTMLInputElement, { target: { value } });
}

/** The combobox field carrying one label, found by the label a person reads. */
function axisField(container: HTMLElement, label: string): HTMLElement | undefined {
  return [...container.querySelectorAll(".meridian-axis-field")].find(
    (field) => field.querySelector(".meridian-axis-field__label")?.textContent === label,
  ) as HTMLElement | undefined;
}

/** Opens one axis's popup and chooses a published option, the way a person does. */
function chooseAxisValue(container: HTMLElement, label: string, value: string): void {
  const field = axisField(container, label);
  expect(field).not.toBeUndefined();
  fireEvent.click(field?.querySelector(".meridian-axis-field__trigger") as HTMLElement);
  const option = [...document.querySelectorAll(".meridian-axis-field__option")].find(
    (candidate) => candidate.textContent === value,
  );
  expect(option).not.toBeUndefined();
  fireEvent.click(option as HTMLElement);
}

/** What one combobox currently shows, which is the draft's own answer for that axis. */
function axisValueOf(container: HTMLElement, label: string): string {
  return (
    axisField(container, label)?.querySelector(".meridian-axis-field__trigger")?.textContent ?? ""
  );
}

function applyActions(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll(".meridian-switch__apply")] as HTMLButtonElement[];
}

describe("provider switch — before the vocabularies are known", () => {
  it("names the read that is in flight and offers no axis to set", () => {
    const { container } = render(
      <ProviderSwitch agent={ON_CLAUDE} catalog={{ kind: "not-loaded" }} onApply={() => {}} />,
    );
    expect(container.textContent ?? "").toContain("Reading what this agent may be moved to");
    expect(container.querySelector(".meridian-axis-field")).toBeNull();
  });

  it("renders the refusal rather than an empty form", () => {
    const { container } = render(
      <ProviderSwitch
        agent={ON_CLAUDE}
        catalog={{ kind: "failed", refusal: refuse("driver-catalog", "read-failed", "no route") }}
        onApply={() => {}}
      />,
    );
    expect(container.textContent ?? "").toContain("no route");
    expect(container.querySelector(".meridian-axis-field")).toBeNull();
  });
});

describe("provider switch — an undeclared capability has no control at all", () => {
  it("omits the output-speed control for a driver that declares no speed axis", () => {
    const { container } = render(
      <ProviderSwitch agent={ON_CODEX} catalog={LOADED} onApply={() => {}} />,
    );
    expect(fieldLabels(container)).not.toContain("Output speed");
    // Absent, not disabled — the whole point of the rule.
    expect(container.querySelector("[disabled]")).toBeNull();
  });

  it("negative control: the declaring driver does get that control", () => {
    // Without this, the case above would pass over a form that never drew the axis
    // for anyone, which would hide a real regression rather than prove the rule.
    const { container } = render(
      <ProviderSwitch agent={ON_CLAUDE} catalog={LOADED} onApply={() => {}} />,
    );
    expect(fieldLabels(container)).toContain("Output speed");
  });

  it("always offers the driver axis, which is gated by no flag", () => {
    for (const agent of [ON_CLAUDE, ON_CODEX]) {
      const { container } = render(
        <ProviderSwitch agent={agent} catalog={LOADED} onApply={() => {}} />,
      );
      expect(fieldLabels(container)).toContain("Driver");
    }
  });
});

describe("provider switch — the consequences are stated before the action is offered", () => {
  it("offers no apply action until an axis has actually been edited", () => {
    const { container } = render(
      <ProviderSwitch agent={ON_CLAUDE} catalog={LOADED} onApply={() => {}} />,
    );
    expect(container.querySelectorAll(".meridian-switch__apply").length).toBe(0);
    expect(container.textContent ?? "").not.toContain("prompt cache");
  });

  it("states the cache loss and names the pending switch it would displace", () => {
    const { container } = render(
      <ProviderSwitch
        agent={{
          ...ON_CLAUDE,
          pendingSwitch: {
            switchId: "switch-7",
            appliesAt: "run_boundary",
            interruptRequested: false,
            pendingAxes: [{ axis: "effort", value: "low" }],
          },
        }}
        catalog={LOADED}
        onApply={() => {}}
      />,
    );
    editProviderAccount(container, "account-2");
    const text = container.textContent ?? "";
    expect(text).toContain("prompt cache");
    expect(text).toContain("switch-7");
    expect(container.querySelectorAll(".meridian-switch__apply").length).toBe(2);
  });

  it("negative control: with nothing pending it claims to displace nothing", () => {
    const { container } = render(
      <ProviderSwitch agent={ON_CLAUDE} catalog={LOADED} onApply={() => {}} />,
    );
    editProviderAccount(container, "account-2");
    expect(container.textContent ?? "").toContain("prompt cache");
    expect(container.textContent ?? "").not.toContain("supersedes the switch already pending");
  });
});

describe("provider switch — what each apply action submits", () => {
  it("submits the edited axes and no interrupt on the deferred action", () => {
    const onApply = vi.fn();
    const { container } = render(
      <ProviderSwitch agent={ON_CLAUDE} catalog={LOADED} onApply={onApply} />,
    );
    editProviderAccount(container, "account-2");
    const [deferred] = [...container.querySelectorAll(".meridian-switch__apply")];
    fireEvent.click(deferred as HTMLButtonElement);
    expect(onApply).toHaveBeenCalledWith({ providerAccountId: "account-2" }, false);
  });

  it("negative control: the second action carries the interrupt flag instead", () => {
    // Two actions that submitted the same flag would make one of them a lie about
    // when the switch lands.
    const onApply = vi.fn();
    const { container } = render(
      <ProviderSwitch agent={ON_CLAUDE} catalog={LOADED} onApply={onApply} />,
    );
    editProviderAccount(container, "account-2");
    const actions = [...container.querySelectorAll(".meridian-switch__apply")];
    fireEvent.click(actions[1] as HTMLButtonElement);
    expect(onApply).toHaveBeenCalledWith({ providerAccountId: "account-2" }, true);
  });

  it("drops an axis cleared back to empty rather than submitting a blank value", () => {
    const onApply = vi.fn();
    const { container } = render(
      <ProviderSwitch agent={ON_CLAUDE} catalog={LOADED} onApply={onApply} />,
    );
    editProviderAccount(container, "account-2");
    editProviderAccount(container, "");
    expect(container.querySelectorAll(".meridian-switch__apply").length).toBe(0);
  });
});

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

describe("provider switch — the settlement rides the reply", () => {
  it("renders the settlement it was handed", () => {
    const { container } = render(
      <ProviderSwitch
        agent={ON_CLAUDE}
        catalog={LOADED}
        onApply={() => {}}
        settlement={{
          status: "applied",
          continuity: "memo",
          declaredLosses: ["context_truncated"],
        }}
      />,
    );
    expect(container.textContent ?? "").toContain("switched");
  });

  it("negative control: no settlement renders no settlement line", () => {
    const { container } = render(
      <ProviderSwitch agent={ON_CLAUDE} catalog={LOADED} onApply={() => {}} />,
    );
    expect(container.querySelector(".meridian-settlement")).toBeNull();
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

describe("provider switch — the draft follows the binding it is a difference from", () => {
  /** The same mount, re-rendered with the agent as the roster now reports it. */
  function withAgent(agent: AgentRosterEntry): React.JSX.Element {
    return <ProviderSwitch agent={agent} catalog={LOADED} onApply={() => {}} />;
  }

  const ON_ACCOUNT_ONE: AgentRosterEntry = {
    ...ON_CLAUDE,
    config: { providerAccountId: "account-1" },
  };

  it("clears a draft the binding has caught up with, and takes the actions away", () => {
    // The defect: the component stays mounted — its key is the agent — so a terminal
    // event applying the switch left the old draft in front of the new authoritative
    // values, with both actions live and a second, now redundant, switch to submit.
    const { container, rerender } = render(withAgent(ON_ACCOUNT_ONE));
    editProviderAccount(container, "account-2");
    expect(applyActions(container).length).toBe(2);

    rerender(withAgent({ ...ON_ACCOUNT_ONE, config: { providerAccountId: "account-2" } }));

    expect(applyActions(container).length).toBe(0);
    expect(providerAccountValue(container)).toBe("account-2");
  });

  it("keeps an axis still being edited and rebases it onto the new values", () => {
    const { container, rerender } = render(withAgent(ON_ACCOUNT_ONE));
    chooseAxisValue(container, "Output speed", "fast");
    editProviderAccount(container, "account-2");

    // The speed landed; the account edit is still the participant's.
    rerender(
      withAgent({
        ...ON_ACCOUNT_ONE,
        config: { providerAccountId: "account-1", outputSpeed: "fast" },
      }),
    );

    expect(applyActions(container).length).toBe(2);
    expect(providerAccountValue(container)).toBe("account-2");
    expect(axisValueOf(container, "Output speed")).toBe("fast");
  });

  it("negative control: a re-read that changed nothing leaves the draft alone", () => {
    // The roster answers with a fresh object every read, so a draft cleared by
    // identity rather than by value would lose the participant's work on a refresh
    // that moved nothing at all.
    const { container, rerender } = render(withAgent(ON_ACCOUNT_ONE));
    editProviderAccount(container, "account-2");

    rerender(withAgent({ ...ON_ACCOUNT_ONE, config: { providerAccountId: "account-1" } }));

    expect(applyActions(container).length).toBe(2);
    expect(providerAccountValue(container)).toBe("account-2");
  });

  it("does not bring a settled draft back when the binding moves on again", () => {
    // The stamp advances rather than only being compared: measured against the
    // binding the draft was born under, `account-2` would read as an edit again the
    // moment someone else moved the account somewhere else.
    const { container, rerender } = render(withAgent(ON_ACCOUNT_ONE));
    editProviderAccount(container, "account-2");
    rerender(withAgent({ ...ON_ACCOUNT_ONE, config: { providerAccountId: "account-2" } }));
    rerender(withAgent({ ...ON_ACCOUNT_ONE, config: { providerAccountId: "account-3" } }));

    expect(applyActions(container).length).toBe(0);
    expect(providerAccountValue(container)).toBe("account-3");
  });
});
