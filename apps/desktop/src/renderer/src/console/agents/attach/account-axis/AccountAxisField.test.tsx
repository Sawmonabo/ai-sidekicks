// The account axis inside the real attach form, over the node's real registry read.
//
// THE MODEL SUITE BESIDE THIS ONE ANSWERS "WHICH ACCOUNTS", and it answers it over a
// literal. What it cannot answer is whether anything reaches the wire: the axis is
// only a registry axis if the form opens the registry, scopes the offer to the driver
// it is carrying, and puts the daemon's own handle on `agent.attach` — three claims
// that are each about a seam between two modules, so they are asserted through the
// column that composes them rather than against the field alone.
//
// THE NEGATIVE CONTROL IS THE SHAPE OF THE AXIS. What stood here was an untyped text
// input beside a standing sentence, which is the one shape that can never be wrong in
// the renderer and is always wrong at the daemon — a typo composes a request naming an
// account the registry has never held, refused in the account plane's own namespace
// after the attach was submitted. So a case asserts the field a person meets is a
// picker over the registry and not a box they type an opaque handle into.

import { act, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { settleReads } from "../../agent-console/agent-console.test-support.js";
import {
  HeldAttachDaemon,
  bridgeCalling,
  currentSubmitControl,
  disposeOpenedModels,
  modelsOver,
  openReadyAttachForm,
  type ScriptedDaemon,
} from "../../agent-console/agent-binding-column.test-support.js";
import { AgentBindingColumn } from "../../agent-console/AgentBindingColumn.js";
import { AccountAxisField, type AccountAxisFieldProps } from "./AccountAxisField.js";

afterEach(disposeOpenedModels);

/** The attach dialog, open, with its registry read settled. */
async function openedAttachForm(scriptedDaemon: ScriptedDaemon): Promise<HTMLElement> {
  const bridge = bridgeCalling(scriptedDaemon);
  const { container } = render(
    <AgentBindingColumn models={modelsOver(bridge)} agentId={undefined} />,
  );
  await settleReads(bridge);
  await openReadyAttachForm(container);
  // A SECOND SETTLE, because the registry read does not exist until the dialog does.
  // The field is the account plane's watcher and it mounts with the popup, so the
  // read this asserts against is opened by the press above and not by the mount.
  await settleReads(bridge);
  return document.querySelector(".meridian-attach__popup") as HTMLElement;
}

/** The account axis's own field, found by the label a person reads. */
function accountField(popup: HTMLElement): HTMLElement {
  const field = [...popup.querySelectorAll(".meridian-axis-field")].find((candidate) =>
    (candidate.querySelector(".meridian-axis-field__label")?.textContent ?? "").startsWith(
      "Provider account",
    ),
  );
  expect(field).not.toBeUndefined();
  return field as HTMLElement;
}

/** Open the account picker and read back what it offers, label by label. */
function offeredAccounts(popup: HTMLElement): string[] {
  fireEvent.click(
    accountField(popup).querySelector(".meridian-axis-field__trigger") as HTMLElement,
  );
  return [...document.querySelectorAll(".meridian-axis-field__option-label")].map(
    (option) => option.textContent ?? "",
  );
}

/** Pick one account by the operator's own word for it, the way a person does. */
function chooseAccount(popup: HTMLElement, label: string): void {
  fireEvent.click(
    accountField(popup).querySelector(".meridian-axis-field__trigger") as HTMLElement,
  );
  const option = [...document.querySelectorAll(".meridian-axis-field__option")].find((candidate) =>
    (candidate.querySelector(".meridian-axis-field__option-label")?.textContent ?? "").startsWith(
      label,
    ),
  );
  expect(option).not.toBeUndefined();
  fireEvent.click(option as HTMLElement);
}

describe("the attach form's account axis — what it offers", () => {
  it("offers the registry's accounts under the driver's provider and no other provider's", async () => {
    const popup = await openedAttachForm(new HeldAttachDaemon());

    expect(offeredAccounts(popup)).toEqual(["Team · default", "Personal"]);
  });

  it("negative control: the axis is a picker over the registry, never a box to type a handle into", async () => {
    // The pre-fix axis was `<input class="meridian-axis-field__text">` beside a
    // standing sentence — a shape that accepts an account this node has never held
    // and cannot say so until the attach has already been submitted.
    const popup = await openedAttachForm(new HeldAttachDaemon());
    const field = accountField(popup);

    expect(field.querySelector(".meridian-axis-field__text")).toBeNull();
    expect(field.querySelector(".meridian-axis-field__trigger")).not.toBeNull();
  });

  it("marks which account the provider would resolve to on its own", async () => {
    // Marked on its row rather than hoisted to the top of the list: the daemon sent
    // the accounts in an order this console has no better answer than, and moving one
    // would be the renderer asserting a precedence the registry did not state.
    const popup = await openedAttachForm(new HeldAttachDaemon());

    expect(offeredAccounts(popup)[0]).toContain("default");
  });
});

describe("the attach form's account axis — what reaches the wire", () => {
  it("puts the daemon's opaque handle on the request when a person picks by label", async () => {
    const scriptedDaemon = new HeldAttachDaemon();
    const popup = await openedAttachForm(scriptedDaemon);

    chooseAccount(popup, "Personal");
    await act(async () => {
      fireEvent.click(currentSubmitControl());
    });

    expect(scriptedDaemon.attachRequest).toMatchObject({ providerAccountId: "acct-personal" });
  });

  it("negative control: the operator's own word for the account reaches the wire never", async () => {
    // The handle is the item and the label is a projection of it. A picker whose
    // items were labels would put a mutable word where the wire's identity belongs,
    // and two accounts relabelled alike would become indistinguishable to it.
    const scriptedDaemon = new HeldAttachDaemon();
    const popup = await openedAttachForm(scriptedDaemon);

    chooseAccount(popup, "Personal");
    await act(async () => {
      fireEvent.click(currentSubmitControl());
    });

    expect(JSON.stringify(scriptedDaemon.attachRequest)).not.toContain("Personal");
  });

  it("clears the pin back to the provider's default rather than sending an empty account", async () => {
    const scriptedDaemon = new HeldAttachDaemon();
    const popup = await openedAttachForm(scriptedDaemon);

    chooseAccount(popup, "Team");
    fireEvent.click(
      accountField(popup).querySelector(".meridian-axis-field__clear") as HTMLElement,
    );
    await act(async () => {
      fireEvent.click(currentSubmitControl());
    });

    expect(scriptedDaemon.attachRequest).not.toHaveProperty("providerAccountId");
  });
});

describe("the attach form's account axis — what it says about the chosen account", () => {
  it("names what run admission last made of that account", async () => {
    const popup = await openedAttachForm(new HeldAttachDaemon());

    chooseAccount(popup, "Personal");
    const text = accountField(popup).textContent ?? "";
    expect(text).toContain("fresh sign-in");
    expect(text).toContain("reauth_required");
  });

  it("says the readiness is advisory rather than a gate, and leaves the control live", async () => {
    const popup = await openedAttachForm(new HeldAttachDaemon());

    chooseAccount(popup, "Personal");
    expect(accountField(popup).textContent ?? "").toContain("advisory and never a gate");
    // Resolution tests registry MEMBERSHIP; a live probe settles authentication at
    // spawn. A form that refused here would refuse an account about to work.
    expect(currentSubmitControl().disabled).toBe(false);
  });

  it("names the act a remedy calls for and never the provider's own sign-in command", async () => {
    // `signInInvocation` and `credentialHomePath` are display-only members that
    // belong to the operator surface that owns them. An attach form printing a
    // command somebody is invited to run would be this console composing a remedy.
    const popup = await openedAttachForm(new HeldAttachDaemon());

    chooseAccount(popup, "Personal");
    const text = accountField(popup).textContent ?? "";
    expect(text).not.toContain("claude setup-token");
    expect(text).not.toContain("/homes/acct-personal");
  });

  it("negative control: an account no readiness entry resolved to carries no verdict", async () => {
    // The projection is per PROVIDER and names one account. Attributing it to every
    // row under that provider would report a state nobody derived.
    const popup = await openedAttachForm(new HeldAttachDaemon());

    chooseAccount(popup, "Team");
    expect(accountField(popup).textContent ?? "").not.toContain("reauth_required");
  });
});

describe("the attach form's account axis — a registry that would not answer", () => {
  /** The attach script with the registry read refused, and everything else scripted. */
  function refusingRegistry(): ScriptedDaemon {
    const scriptedDaemon = new HeldAttachDaemon();
    return {
      answer: async (method: string, params?: unknown): Promise<unknown> => {
        if (method === "providerAccount.list") {
          throw new Error("the account plane refused this caller");
        }
        return await scriptedDaemon.answer(method, params);
      },
    };
  }

  it("renders the refusal verbatim rather than an empty picker", async () => {
    // The two are different facts and only one of them is "there are no accounts". A
    // field that drew an empty list over a refused read would report a registry that
    // had not answered as a registry that had answered nothing.
    const popup = await openedAttachForm(refusingRegistry());
    const text = accountField(popup).textContent ?? "";

    expect(text).toContain("call-rejected");
    expect(text).toContain("providerAccount.list was rejected.");
    expect(text).not.toContain("No account is registered for this provider");
  });

  it("carries its own way out, since nothing else asks the registry again", async () => {
    // A refused read is terminal until something asks again, so without this the
    // field would say one line of error text for the life of the dialog.
    const popup = await openedAttachForm(refusingRegistry());
    const retry = [...accountField(popup).querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "Try again",
    );

    expect(retry).not.toBeUndefined();
  });

  it("negative control: a registry that answers renders no refusal at all", async () => {
    // Without this, the cases above would pass over a field that rendered a refusal
    // for every reading it was ever handed.
    const popup = await openedAttachForm(new HeldAttachDaemon());

    expect(accountField(popup).textContent ?? "").not.toContain("call-rejected");
  });
});

// THE AXIS ALONE, for the two claims a column render cannot make. The three states
// the reset control distinguishes differ only in what the FORM is holding behind the
// field — an entry over a definition's account, an entry over nothing, and a
// definition's account with no entry at all — and the column's own fixtures reach
// exactly one of them. Driven here through the real component over the real registry
// read, with the form's two facts passed as the props they are.
describe("the account axis — what its reset control promises", () => {
  /** The field on its own, with the registry read settled. */
  async function renderedAxis(
    axis: Pick<AccountAxisFieldProps, "value" | "inheritedValue" | "isOverridden">,
    onValueChange: (accountId: string | undefined) => void = () => {},
  ): Promise<HTMLElement> {
    const bridge = bridgeCalling(new HeldAttachDaemon());
    const { container } = render(
      <AccountAxisField
        bridge={bridge}
        driverName="claude"
        value={axis.value}
        inheritedValue={axis.inheritedValue}
        isOverridden={axis.isOverridden}
        onValueChange={onValueChange}
      />,
    );
    await settleReads(bridge);
    return container;
  }

  /** The reset control as it stands now, or `undefined` where none is drawn. */
  function resetControl(container: HTMLElement): HTMLButtonElement | undefined {
    return (
      (container.querySelector(".meridian-axis-field__clear") as HTMLButtonElement) ?? undefined
    );
  }

  it("names the definition's account where dropping the entry is what a press does", async () => {
    const container = await renderedAxis({
      value: "acct-personal",
      inheritedValue: "acct-team",
      isOverridden: true,
    });

    expect(resetControl(container)?.textContent).toBe("Use the definition’s account");
  });

  it("hands the drop up, which is the whole of what the press performs", async () => {
    const dropped = vi.fn<(accountId: string | undefined) => void>();
    const container = await renderedAxis(
      { value: "acct-personal", inheritedValue: "acct-team", isOverridden: true },
      dropped,
    );

    fireEvent.click(resetControl(container) as HTMLButtonElement);
    // `undefined` and never the definition's account: substituting the inherited
    // value here would send it as an explicit override, which is the opposite of
    // returning the field to the definition.
    expect(dropped).toHaveBeenCalledWith(undefined);
  });

  it("draws no control at all over a definition's own inherited account", async () => {
    // The defect this replaces: the button stood here saying "Use the provider's
    // default account", and a press dropped an entry that did not exist, so the
    // field fell straight back to the same pinned account and the attach still used
    // it. A control that cannot perform its label is absent rather than disabled.
    const container = await renderedAxis({
      value: "acct-team",
      inheritedValue: "acct-team",
      isOverridden: false,
    });

    expect(resetControl(container)).toBeUndefined();
    expect(container.textContent ?? "").not.toContain("default account");
    expect(container.textContent ?? "").toContain("This account is the definition’s");
  });

  it("negative control: an entry standing over nothing does reach the provider default", async () => {
    // Without this, the case above would pass over a field that had simply stopped
    // drawing the control — and the inline arm, where dropping an entry really does
    // leave the axis unset, would lose its way back.
    const container = await renderedAxis({
      value: "acct-personal",
      inheritedValue: undefined,
      isOverridden: false,
    });

    expect(resetControl(container)?.textContent).toBe("Use the provider’s default account");
  });

  it("negative control: an unpinned axis offers nothing to reset", async () => {
    const container = await renderedAxis({
      value: undefined,
      inheritedValue: undefined,
      isOverridden: false,
    });

    expect(resetControl(container)).toBeUndefined();
  });
});

describe("the account axis — the picker's accessible name", () => {
  /** The field, unpinned and served — the state a person meets it in. */
  async function renderedUnpinnedAxis(): Promise<HTMLElement> {
    const bridge = bridgeCalling(new HeldAttachDaemon());
    const { container } = render(
      <AccountAxisField
        bridge={bridge}
        driverName="claude"
        value={undefined}
        inheritedValue={undefined}
        isOverridden={false}
        onValueChange={() => {}}
      />,
    );
    await settleReads(bridge);
    return container;
  }

  it("names the trigger with the field's own visible label", async () => {
    // The trigger renders `role="combobox"`, which takes no name from its own
    // content, and this field's root is a `div` rather than a `<label>` — so before
    // the association it was an unnamed interactive control, and in this state, with
    // no account pinned, it carried no value text to be read out either.
    const field = within(await renderedUnpinnedAxis());

    expect(field.getByRole("combobox", { name: "Provider account" })).not.toBeNull();
  });

  it("negative control: the query is naming the control rather than matching anything", async () => {
    // Two halves. A control IS present, so the case above fails on the name and not
    // on an absent trigger; and a name the field does not carry finds nothing, so a
    // matcher that matched everything would be caught here.
    const field = within(await renderedUnpinnedAxis());

    expect(field.getAllByRole("combobox")).toHaveLength(1);
    expect(field.queryByRole("combobox", { name: "Model" })).toBeNull();
  });
});
