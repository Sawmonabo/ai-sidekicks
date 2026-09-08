// The account axis on its own, for the claims a column render cannot make.
//
// THE THREE STATES THE RESET CONTROL DISTINGUISHES differ only in what the FORM is
// holding behind the field — an entry over a definition's account, an entry over
// nothing, and a definition's account with no entry at all — and the column's own
// fixtures reach exactly one of them. So does the fourth state this file is about:
// nothing pinned at all, which is the state a person MEETS the field in and the one
// where the readings beside it are about an account the form is not pinning.
//
// Driven through the real component over the real registry read, with the form's two
// facts passed as the props they are. What reaches the wire is asserted through the
// column instead, in `AccountAxisField.test.tsx`, because only the column composes the
// request.

import { fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { settleReads } from "../../agent-console/agent-console.test-support.js";
import {
  HeldAttachDaemon,
  bridgeCalling,
  disposeOpenedModels,
  type ScriptedDaemon,
} from "../../agent-console/agent-binding-column.test-support.js";
import { registryWithNoDefaultReply } from "./account-registry.test-support.js";
import { AccountAxisField, type AccountAxisFieldProps } from "./AccountAxisField.js";

afterEach(disposeOpenedModels);

/** One case's field: the form's own two facts, plus whatever it wants scripted. */
interface AxisCase extends Pick<
  AccountAxisFieldProps,
  "value" | "inheritedValue" | "isOverridden"
> {
  readonly onValueChange?: (accountId: string | undefined) => void;
  readonly scriptedDaemon?: ScriptedDaemon;
}

/** The field on its own, with the registry read settled. */
async function renderedAxis(axis: AxisCase): Promise<HTMLElement> {
  const bridge = bridgeCalling(axis.scriptedDaemon ?? new HeldAttachDaemon());
  const { container } = render(
    <AccountAxisField
      bridge={bridge}
      driverName="claude"
      value={axis.value}
      inheritedValue={axis.inheritedValue}
      isOverridden={axis.isOverridden}
      onValueChange={axis.onValueChange ?? ((): void => {})}
    />,
  );
  await settleReads(bridge);
  return container;
}

/** The reset control as it stands now, or `undefined` where none is drawn. */
function resetControl(container: HTMLElement): HTMLButtonElement | undefined {
  return (container.querySelector(".meridian-axis-field__clear") as HTMLButtonElement) ?? undefined;
}

describe("the account axis — what its reset control promises", () => {
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
    const container = await renderedAxis({
      value: "acct-personal",
      inheritedValue: "acct-team",
      isOverridden: true,
      onValueChange: dropped,
    });

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

// THE STATE A PERSON MEETS THE FIELD IN. Nothing pinned is a REQUEST for the
// provider's registered default, and the readiness entry already names the account
// that resolution reached — so a field that spoke only for a pinned value said nothing
// at all in the common case, and a default in `reauth_required` stayed silent until the
// daemon refused the attach. The fixture's registry marks `acct-team` default and its
// entry resolved `acct-personal`, which is what makes these cases about the ENTRY
// rather than about the flag.
describe("the account axis — the account an unpinned attach resolves to", () => {
  /** The attach script with accounts registered and none of them the default. */
  function registryWithNoDefault(): ScriptedDaemon {
    const scriptedDaemon = new HeldAttachDaemon();
    return {
      answer: async (method: string, params?: unknown): Promise<unknown> =>
        method === "providerAccount.list"
          ? registryWithNoDefaultReply()
          : await scriptedDaemon.answer(method, params),
    };
  }

  /** The field with nothing pinned, which is how the attach dialog opens. */
  async function unpinnedAxis(scriptedDaemon?: ScriptedDaemon): Promise<HTMLElement> {
    return await renderedAxis({
      value: undefined,
      inheritedValue: undefined,
      isOverridden: false,
      ...(scriptedDaemon === undefined ? {} : { scriptedDaemon }),
    });
  }

  it("shows the stored reading, the admission state, and the remedy of the resolved account", async () => {
    const text = (await unpinnedAxis()).textContent ?? "";

    expect(text).toContain("needing a fresh sign-in");
    expect(text).toContain("Run admission last read this provider as reauth_required.");
    expect(text).toContain("Signing this account in again is what run admission is waiting for.");
  });

  it("says which account the readings are about, and that the form pins none", async () => {
    // The one confusion this addition could introduce is a default's health read as a
    // pinned one's, so which account a list is about is said before the list.
    const text = (await unpinnedAxis()).textContent ?? "";

    expect(text).toContain("Nothing is pinned, so this attach resolves to Personal.");
    expect(text).toContain("the request still names no account");
  });

  it("takes the account the entry resolved and never the row the registry marks default", async () => {
    // `acct-team` carries the `isProviderDefault` flag in this fixture and `Personal`
    // is what resolution reached. The flag is what the registry MARKS; the entry is
    // the spawn path's own answer, and a field keyed on the flag would report the
    // health of an account this attach is not going to use.
    const text = (await unpinnedAxis()).textContent ?? "";

    expect(text).toContain("resolves to Personal");
    expect(text).not.toContain("resolves to Team");
  });

  it("writes nothing, because naming the default is not pinning it", async () => {
    const written = vi.fn<(accountId: string | undefined) => void>();
    await renderedAxis({
      value: undefined,
      inheritedValue: undefined,
      isOverridden: false,
      onValueChange: written,
    });

    expect(written).not.toHaveBeenCalled();
  });

  it("names the remedy where resolution reached no account at all", async () => {
    // The state that rendered NOTHING before this rule: accounts exist, none is the
    // default, so there is no resolved row whose readings could carry the remedy and
    // the form went on asking for a default the daemon would refuse.
    const text = (await unpinnedAxis(registryWithNoDefault())).textContent ?? "";

    expect(text).toContain(
      "Accounts are registered for this provider and none of them is the default.",
    );
  });

  it("negative control: a pinned axis shows that account's readings and not the default's", async () => {
    // Without this the derivation could speak over every state, and a person looking
    // at a pinned account would be reading a different account's health.
    const container = await renderedAxis({
      value: "acct-team",
      inheritedValue: undefined,
      isOverridden: false,
    });
    const text = container.textContent ?? "";

    expect(text).toContain("What follows is about Team, the account this form pins.");
    expect(text).not.toContain("resolves to");
    expect(text).not.toContain("reauth_required");
    expect(text).not.toContain("Signing this account in again");
  });

  it("negative control: a registry that resolves an account names no missing default", async () => {
    // The two are different facts — an entry that resolved a row, and one that
    // resolved none — and without this the remedy sentence could render beside the
    // resolved row's own list, saying twice what the list already says once.
    const text = (await unpinnedAxis()).textContent ?? "";

    expect(text).not.toContain("none of them is the default");
  });
});

describe("the account axis — the picker's accessible name", () => {
  /** The field, unpinned and served — the state a person meets it in. */
  async function renderedUnpinnedAxis(): Promise<HTMLElement> {
    return await renderedAxis({
      value: undefined,
      inheritedValue: undefined,
      isOverridden: false,
    });
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
