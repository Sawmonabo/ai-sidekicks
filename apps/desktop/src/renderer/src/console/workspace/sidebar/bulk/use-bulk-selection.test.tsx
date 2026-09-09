// What the column's selection belongs to: one session, and never the mount.
//
// The model itself — what it holds, what it scopes, what survives a clear — is
// `bulk-selection.test.ts` next door. This file is about the one thing the class
// cannot answer for itself: which selection a column that has moved to another session
// is holding.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../../../bridge/index.js";
import { COMPOSER_SCENARIO } from "../../../bridge/scenario/composer/composer.js";
import { type SidebarBulkItem } from "../../../seats/index.js";
import { useBulkSelectionModel, useBulkSelectionSnapshot } from "./use-bulk-selection.js";

const QUEUED_ITEM: SidebarBulkItem = {
  sectionId: "runs",
  act: "cancel-queue-item",
  itemId: "queue-1",
  label: "Draft the migration",
};

/**
 * A column, reduced to the two acts that make the defect visible.
 *
 * The real column reaches these through eight section bodies and a bar; what matters
 * here is that one render tree ticks a row and settles it, and the same tree is then
 * handed another session — which is exactly what the workspace does to the sidebar.
 */
function BulkSelectionProbe(props: {
  readonly bridge: ConsoleBridge;
  readonly sessionId: string;
}): React.JSX.Element {
  const model = useBulkSelectionModel(props.bridge, props.sessionId);
  const snapshot = useBulkSelectionSnapshot(model);
  return (
    <div>
      <button
        type="button"
        className="probe-select"
        onClick={() => {
          model.toggle(QUEUED_ITEM);
        }}
      >
        Select the queued item
      </button>
      <button
        type="button"
        className="probe-settle"
        onClick={() => {
          model.markDone(QUEUED_ITEM);
        }}
      >
        Settle it
      </button>
      <p className="probe-reading">
        {String(snapshot.selectedItems.length)} selected, {String(snapshot.outcomeByItemKey.size)}{" "}
        settled
      </p>
    </div>
  );
}

function press(container: HTMLElement, selector: string): void {
  const control = container.querySelector(selector);
  if (!(control instanceof HTMLButtonElement)) {
    throw new Error(`the probe rendered no ${selector} control`);
  }
  act(() => {
    control.click();
  });
}

function reading(container: HTMLElement): string {
  return String(container.querySelector(".probe-reading")?.textContent);
}

describe("the column's bulk selection across a session switch", () => {
  it("hands the next session an empty selection and no outcomes", () => {
    // The defect: the model was held for the MOUNT, so session A's ticked rows and
    // settled outcomes were still there when the column re-bound to session B — and
    // the bar then handed B's session id to the runner beside A's ids.
    const bridge: ConsoleBridge = createFixtureBridge({ scenario: COMPOSER_SCENARIO });
    const { container, rerender } = render(
      <BulkSelectionProbe bridge={bridge} sessionId="session-a" />,
    );
    press(container, ".probe-select");
    press(container, ".probe-settle");
    expect(reading(container)).toBe("1 selected, 1 settled");

    rerender(<BulkSelectionProbe bridge={bridge} sessionId="session-b" />);

    expect(reading(container)).toBe("0 selected, 0 settled");
  });

  it("negative control: the same column staying on one session keeps its selection", () => {
    // Without this the case above would pass over a hook that minted a fresh model on
    // every render, which would drop a person's ticks the moment anything else in the
    // column moved — a filter keystroke, a section opening, a row settling.
    const bridge: ConsoleBridge = createFixtureBridge({ scenario: COMPOSER_SCENARIO });
    const { container, rerender } = render(
      <BulkSelectionProbe bridge={bridge} sessionId="session-a" />,
    );
    press(container, ".probe-select");

    rerender(<BulkSelectionProbe bridge={bridge} sessionId="session-a" />);

    expect(reading(container)).toBe("1 selected, 0 settled");
  });
});
