// The bar and its confirm: what is offered, what the preview names, and what the
// confirm claims while it is up.

import { act, render } from "@testing-library/react";

import { crossMacrotaskBoundary } from "../../../core/macrotask-boundary.test-support.js";

import { createFixtureBridge, type ConsoleBridge } from "../../../bridge/index.js";
import {
  unscriptedScenario,
  withDaemonCall,
} from "../../../bridge/fixture/fixture-bridge.test-support.js";
import { airspaceRegistryFor } from "../../../core/index.js";
import { type SidebarBulkItem } from "../../../seats/index.js";
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
  options: { readonly bridge?: ConsoleBridge } = {},
): HTMLElement {
  const bridge =
    options.bridge ?? createFixtureBridge({ scenario: unscriptedScenario("sidebar-bulk-bar") });
  const { container } = render(
    <BulkActionBar model={model} bridge={bridge} sessionId={SESSION_ID} />,
  );
  return container;
}

/**
 * One bar and one bridge, with the route from one session's selection to another's.
 *
 * A RE-RENDER AND NOT A REMOUNT, which is the shape the column has in the sidebar: the
 * bar is mounted once and handed a model that is re-minted with the session, so
 * anything it holds for the life of the MOUNT survives the route. One bridge across
 * both renders, so the model is the only thing that moves.
 */
function renderRoutableBar(model: BulkSelectionModel): {
  readonly container: HTMLElement;
  readonly routeTo: (next: BulkSelectionModel) => void;
} {
  const bridge = createFixtureBridge({ scenario: unscriptedScenario("sidebar-bulk-bar") });
  const barFor = (forModel: BulkSelectionModel): React.JSX.Element => (
    <BulkActionBar model={forModel} bridge={bridge} sessionId={SESSION_ID} />
  );
  const { container, rerender } = render(barFor(model));
  return {
    container,
    routeTo: (next) => {
      rerender(barFor(next));
    },
  };
}

/** Press the first act the bar offers, which is what stages a confirm. */
function stageConfirm(container: HTMLElement): void {
  act(() => {
    container.querySelector<HTMLButtonElement>(".meridian-sidebar-bulk__act")?.click();
  });
}

/** The rows the staged confirm is previewing, or none where no confirm is up. */
function confirmItemLabels(container: HTMLElement): readonly string[] {
  return buttonsNamed(container, ".meridian-sidebar-bulk__confirm-items li");
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
      // A boundary rather than a counted microtask: the confirm dispatches a fan-out
      // whose depth is the act table's, not this case's.
      await crossMacrotaskBoundary();
    });

    expect(calls.map((call) => call.method)).toStrictEqual(["run.queueCancel"]);
  });

  it("registers the confirm in the window's own airspace, and removes it on cancel", () => {
    // Through `primitives/airspace-registration.ts` and into the registry the window's
    // document holds, which is the pair of facts this case is about. The registration
    // it replaced was a hand `claim` at this call site — the shape 12.3's Never bullet
    // forbids — into a SECOND registry the workspace family declared, so every overlay
    // it held was invisible to the predicate a native view actually reads.
    const airspace = airspaceRegistryFor(document);
    const before = airspace.registeredCount;
    const model = new BulkSelectionModel();
    model.toggle(FIRST_QUEUED);
    const container = renderBar(model);

    expect(airspace.registeredCount).toBe(before);
    act(() => {
      container.querySelector<HTMLButtonElement>(".meridian-sidebar-bulk__act")?.click();
    });
    expect(airspace.registeredCount).toBe(before + 1);

    act(() => {
      container.querySelector<HTMLButtonElement>(".meridian-sidebar-bulk__confirm-cancel")?.click();
    });

    expect(airspace.registeredCount).toBe(before);
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

describe("the bulk action bar — a staged act belongs to the selection it was staged over", () => {
  it("puts the confirm away when the column routes to another session's selection", () => {
    // The defect: the pending act was mount state beside a model that is session-keyed,
    // so a route left the first session's staged act standing over the second session's
    // rows — the preview re-read `selectedFor` against the arriving model and previewed
    // ITS rows under a confirm nobody had opened for them, one press from running.
    const firstSession = new BulkSelectionModel();
    firstSession.toggle(FIRST_QUEUED);
    const { container, routeTo } = renderRoutableBar(firstSession);
    stageConfirm(container);
    expect(confirmItemLabels(container)).toStrictEqual(["Draft the migration"]);

    // The same act, so the arriving selection has rows the stale confirm can preview.
    // A second session selecting nothing for it would hide the defect behind the
    // dialog's own empty arm rather than showing it.
    const secondSession = new BulkSelectionModel();
    secondSession.toggle(SECOND_QUEUED);
    routeTo(secondSession);

    expect(confirmItemLabels(container)).toStrictEqual([]);
    expect(container.querySelector(".meridian-sidebar-bulk__confirm")).toBeNull();
  });

  it("negative control: a confirm nothing routed away from is still previewing its rows", () => {
    // Without this, the case above would pass over a bar whose confirm never opened,
    // and over one that closed on every re-render — a selection toggled while the
    // preview is up re-renders this bar, and the preview has to survive that.
    const session = new BulkSelectionModel();
    session.toggle(FIRST_QUEUED);
    const { container, routeTo } = renderRoutableBar(session);
    stageConfirm(container);

    routeTo(session);

    expect(confirmItemLabels(container)).toStrictEqual(["Draft the migration"]);
  });
});
