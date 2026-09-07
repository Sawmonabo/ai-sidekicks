// The bar and its confirm: what is offered, what the preview names, and what the
// confirm claims while it is up.

import { act, render } from "@testing-library/react";

import { createFixtureBridge, type ConsoleBridge } from "../../../bridge/index.js";
import {
  unscriptedScenario,
  withDaemonCall,
} from "../../../bridge/fixture/fixture-bridge.test-support.js";
import { type SidebarBulkItem } from "../../../seats/index.js";
import { AirspaceRegistry } from "../../deck/rect-discipline.js";
import { BulkActionBar } from "./BulkActionBar.js";
import { BulkSelectionModel } from "./bulk-selection.js";

const SESSION_ID = "9f2c4a10-0000-4000-8000-0000000000aa";
const QUEUE_ITEM_ONE = "9f2c4a10-0000-4000-8000-000000000001";
const QUEUE_ITEM_TWO = "9f2c4a10-0000-4000-8000-000000000002";
const INVITE_ID = "9f2c4a10-0000-4000-8000-0000000000bb";

const FIRST_QUEUED: SidebarBulkItem = {
  sectionId: "runs",
  act: "cancel-queue-item",
  itemId: QUEUE_ITEM_ONE,
  label: "Draft the migration",
};
const SECOND_QUEUED: SidebarBulkItem = {
  sectionId: "runs",
  act: "cancel-queue-item",
  itemId: QUEUE_ITEM_TWO,
  label: "Rebase onto develop",
};
const INVITE: SidebarBulkItem = {
  sectionId: "members",
  act: "revoke-invite",
  itemId: INVITE_ID,
  label: "ada@example.test",
};

function renderBar(
  model: BulkSelectionModel,
  options: { readonly airspace?: AirspaceRegistry; readonly bridge?: ConsoleBridge } = {},
): HTMLElement {
  const bridge =
    options.bridge ?? createFixtureBridge({ scenario: unscriptedScenario("sidebar-bulk-bar") });
  const { container } = render(
    <BulkActionBar
      model={model}
      bridge={bridge}
      sessionId={SESSION_ID}
      {...(options.airspace === undefined ? {} : { airspace: options.airspace })}
    />,
  );
  return container;
}

function buttonsNamed(container: HTMLElement, selector: string): readonly string[] {
  return [...container.querySelectorAll(selector)].map((element) =>
    (element.textContent ?? "").replaceAll(/\s+/gu, " ").trim(),
  );
}

describe("the bulk action bar", () => {
  it("draws nothing at all while nothing is selected and nothing has run", () => {
    // A bar with no rows is a strip of chrome that answers nothing, and drawing one
    // would take a line of the column away from the tree permanently.
    expect(renderBar(new BulkSelectionModel()).querySelector(".meridian-sidebar-bulk")).toBeNull();
  });

  it("offers one act per act in the selection, each with its own count", () => {
    // Two acts because two kinds of row are selected — and NOT three, which is what
    // a bar drawn from the act table rather than from the selection would show.
    const model = new BulkSelectionModel();
    model.toggle(FIRST_QUEUED);
    model.toggle(SECOND_QUEUED);
    model.toggle(INVITE);

    const container = renderBar(model);

    expect(buttonsNamed(container, ".meridian-sidebar-bulk__act")).toStrictEqual([
      "Cancel queued (2)",
      "Revoke invites (1)",
    ]);
  });

  it("previews the whole set and names every item before anything is sent", () => {
    // "Destructive bulk operations preview the whole set and require confirm on the
    // preview" — the list is the thing a person can check, so it names the rows
    // rather than counting them.
    const model = new BulkSelectionModel();
    model.toggle(FIRST_QUEUED);
    model.toggle(SECOND_QUEUED);
    const container = renderBar(model);

    act(() => {
      container.querySelector<HTMLButtonElement>(".meridian-sidebar-bulk__act")?.click();
    });

    expect(buttonsNamed(container, ".meridian-sidebar-bulk__confirm-items li")).toStrictEqual([
      "Draft the migration",
      "Rebase onto develop",
    ]);
    expect(
      container.querySelector(".meridian-sidebar-bulk__confirm-summary")?.textContent,
    ).toContain("2 queued items");
  });

  it("sends nothing until the confirm is pressed", async () => {
    const model = new BulkSelectionModel();
    model.toggle(FIRST_QUEUED);
    const { bridge, calls } = withDaemonCall(
      createFixtureBridge({ scenario: unscriptedScenario("sidebar-bulk-bar") }),
      async (call) =>
        await Promise.resolve({
          queueItemId: (call.params as { readonly queueItemId: string }).queueItemId,
          state: "canceled",
        }),
    );
    const container = renderBar(model, { bridge });

    act(() => {
      container.querySelector<HTMLButtonElement>(".meridian-sidebar-bulk__act")?.click();
    });
    expect(calls).toStrictEqual([]);

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".meridian-sidebar-bulk__confirm-run")?.click();
      await Promise.resolve();
    });

    expect(calls.map((call) => call.method)).toStrictEqual(["run.queueCancel"]);
  });

  it("claims the airspace while the confirm is up and hands it back on cancel", () => {
    // A dialog that did not claim it would be drawn under a native browser view,
    // which is not a z-index this renderer can win.
    const airspace = new AirspaceRegistry();
    const model = new BulkSelectionModel();
    model.toggle(FIRST_QUEUED);
    const container = renderBar(model, { airspace });

    expect(airspace.isOccupied).toBe(false);
    act(() => {
      container.querySelector<HTMLButtonElement>(".meridian-sidebar-bulk__act")?.click();
    });
    expect(airspace.isOccupied).toBe(true);

    act(() => {
      container.querySelector<HTMLButtonElement>(".meridian-sidebar-bulk__confirm-cancel")?.click();
    });

    expect(airspace.isOccupied).toBe(false);
  });

  it("renders each settled row's own outcome, refusal beside success", () => {
    // The rolled-up answer this surface exists to avoid: one refused row and one
    // served row, both on screen, neither standing in for the other.
    const model = new BulkSelectionModel();
    model.markDone(FIRST_QUEUED);
    model.markRefused(SECOND_QUEUED, {
      code: "queue.item_not_cancelable",
      detail: "The item has already been admitted.",
      origin: "daemon",
    });

    const container = renderBar(model);
    const outcomes = [...container.querySelectorAll(".meridian-sidebar-bulk__outcome")].map(
      (element) => (element.textContent ?? "").replaceAll(/\s+/gu, " ").trim(),
    );

    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]).toBe("Draft the migration accepted");
    expect(outcomes[1]).toContain("queue.item_not_cancelable");
  });

  it("drops the outcomes only when they are dismissed", () => {
    const model = new BulkSelectionModel();
    model.markDone(FIRST_QUEUED);
    const container = renderBar(model);

    act(() => {
      container.querySelector<HTMLButtonElement>(".meridian-sidebar-bulk__dismiss")?.click();
    });

    expect(container.querySelector(".meridian-sidebar-bulk")).toBeNull();
  });
});
