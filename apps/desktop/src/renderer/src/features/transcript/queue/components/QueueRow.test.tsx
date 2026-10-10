// A queue row's times, drawn against the instant the list hands it.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { liveBridgeWrapper } from "#test/helpers/app/frame-fixtures.js";

import { formatRelativeTime } from "#renderer/lib/wire/figures.js";
import { queueRow } from "../feed.test-support.js";
import { QueueRow } from "./QueueRow.js";

// A fixture instant built directly, not parsed: half an hour after the row was created.
const NOW_MILLISECONDS = Date.UTC(2026, 8, 2, 9, 30, 0);

describe("a queue row's times", () => {
  it("reads when the item was created and updated in the long form, ago and all", () => {
    const item = queueRow("8a4d2e61-15b3-4c79-8e20-1f9b7c3a5d02", "queued", "2026-09-02T09:20:00Z");
    const { container } = render(
      <ol>
        <QueueRow
          item={item}
          isCancelPending={false}
          onCancel={() => Promise.resolve()}
          nowMilliseconds={NOW_MILLISECONDS}
        />
      </ol>,
      { wrapper: liveBridgeWrapper() },
    );
    const times = [...container.querySelectorAll(".meridian-queue__figure dd")]
      .slice(1)
      .map((figure) => figure.textContent);
    expect(times).toStrictEqual([
      formatRelativeTime(item.createdAt, NOW_MILLISECONDS),
      formatRelativeTime(item.updatedAt, NOW_MILLISECONDS),
    ]);
  });
});
