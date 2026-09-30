// A view says less than complete, never more: every state other than a served reading renders
// something visible.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PartialRead } from "./PartialRead.js";
import { READING_STATE_KINDS, type ReadingState } from "@renderer/lib/partial-read.js";
import { READING_SUBJECT, STATE_BY_KIND } from "@test/helpers/partial-read.js";

function renderNotice(...states: readonly ReadingState[]): HTMLElement {
  const { container } = render(<PartialRead states={states} subject={READING_SUBJECT} />);
  return container;
}

describe("PartialRead — a view says less than complete, never more", () => {
  it("renders something visible for every state but a served one", () => {
    for (const kind of READING_STATE_KINDS) {
      if (kind === "served") {
        continue;
      }
      const container = renderNotice(STATE_BY_KIND[kind]);
      expect(container.innerHTML, `the ${kind} state rendered nothing`).not.toBe("");
    }
  });
});
