// The way from the in-session picker to where definitions are kept.
//
// THE LINK IS DRAWN UNDER EVERY ARM, and the empty one is the case that decides it: a
// person with no saved definitions is exactly the person who wants the page, and a
// link hung on the rows would be missing for them. So the four answers are asserted
// one by one rather than through whichever arm happens to be convenient.
//
// AND IT IS ABSENT WHERE THERE IS NOWHERE TO GO. The auxiliary agent-console window
// draws its own frame, carries no settings rail, and routes to no settings address,
// so its mount hands no navigation. A disabled link there would assert a destination
// that exists and is momentarily unavailable, which in that window is false.

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { refuse } from "../../core/index.js";
import type { PushDrivenReadState } from "../../seats/index.js";
import type { SidekickDefinitionListReading } from "../agent-wire.js";
import { AttachSidekickForm } from "./attach-model.js";
import { DefinitionPicker } from "./DefinitionPicker.js";

/** One served reading over the definitions a case cares about. */
function served(
  definitions: SidekickDefinitionListReading["definitions"],
): PushDrivenReadState<SidekickDefinitionListReading> {
  return { kind: "loaded", value: { definitions } };
}

const IN_FLIGHT: PushDrivenReadState<SidekickDefinitionListReading> = { kind: "not-loaded" };
const REFUSED: PushDrivenReadState<SidekickDefinitionListReading> = {
  kind: "failed",
  refusal: refuse("sidekick-registry", "sidekick.definition_unreadable", "no route"),
};
const NOTHING_SAVED: PushDrivenReadState<SidekickDefinitionListReading> = served([]);
const WITH_ROWS: PushDrivenReadState<SidekickDefinitionListReading> = served([
  { definitionId: "definition-1", name: "Reviewer", driverName: "claude" },
]);

/** The four readings the picker answers, named so a case reads as its own arm. */
const ARMS: readonly (readonly [string, PushDrivenReadState<SidekickDefinitionListReading>])[] = [
  ["a read still in flight", IN_FLIGHT],
  ["a read the port refused", REFUSED],
  ["a registry with nothing in it", NOTHING_SAVED],
  ["a registry with rows", WITH_ROWS],
];

/** The link, as a person would find it. */
function definitionsLink(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector(".meridian-attach__definitions-link");
}

describe("the attach picker — reaching the page where definitions are kept", () => {
  for (const [arm, definitions] of ARMS) {
    it(`offers the way there under ${arm}`, () => {
      const { container } = render(
        <DefinitionPicker
          form={new AttachSidekickForm()}
          definitions={definitions}
          onOpenDefinitions={() => {}}
        />,
      );

      expect(definitionsLink(container)?.textContent).toBe("Manage saved sidekicks");
    });
  }

  it("navigates through the mount rather than composing a route of its own", () => {
    const openDefinitions = vi.fn();
    const { container } = render(
      <DefinitionPicker
        form={new AttachSidekickForm()}
        definitions={WITH_ROWS}
        onOpenDefinitions={openDefinitions}
      />,
    );

    fireEvent.click(definitionsLink(container) as HTMLButtonElement);

    expect(openDefinitions).toHaveBeenCalledTimes(1);
  });

  it("negative control: a mount that cannot navigate draws no link at all", () => {
    // Absent, never disabled. Without this the cases above would pass over a picker
    // that drew the link in the auxiliary window too, where it goes nowhere.
    const { container } = render(
      <DefinitionPicker form={new AttachSidekickForm()} definitions={WITH_ROWS} />,
    );

    expect(definitionsLink(container)).toBeNull();
    expect(container.querySelector("[disabled]")).toBeNull();
  });

  it("still shows the arm it was drawn for beside the link", () => {
    // The link is added to the picker, not instead of it: a wrapper that swallowed
    // the empty arm's sentence would leave a person with a link and no explanation.
    const { container } = render(
      <DefinitionPicker
        form={new AttachSidekickForm()}
        definitions={NOTHING_SAVED}
        onOpenDefinitions={() => {}}
      />,
    );

    expect(container.textContent ?? "").toContain("No sidekick definitions exist yet.");
  });
});
