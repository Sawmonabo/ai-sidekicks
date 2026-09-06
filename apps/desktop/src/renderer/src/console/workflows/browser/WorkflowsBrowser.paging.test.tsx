// The handle to the next page: offered exactly while the daemon hands back a cursor.
//
// What happens when it is PRESSED is a claim about what the surface then says, and it
// lives with the announcement cases next door — this suite is only about whether the
// control is there to press.

import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { renderBrowser } from "./WorkflowsBrowser.test-support.js";
import {
  SECOND_PAGE_CURSOR,
  definition,
  portAnswering,
  settle,
} from "../workflows-probe.test-support.js";

describe("the workflows browser — the handle to the next page", () => {
  afterEach(() => {
    cleanup();
  });

  it("offers the continuation while the daemon hands back a cursor", async () => {
    const container = renderBrowser(
      portAnswering({
        status: "served",
        value: { definitions: [definition()], nextCursor: SECOND_PAGE_CURSOR },
      }),
    );

    await settle();

    expect(container.querySelector(".meridian-definitions-continuation button")?.textContent).toBe(
      "Show more definitions",
    );
  });

  it("negative control: no cursor, no control", async () => {
    // Absent, not disabled. Without this the case above would pass over a browser that
    // offered the handle unconditionally, and pressing it would re-read one page.
    const container = renderBrowser(
      portAnswering({ status: "served", value: { definitions: [definition()] } }),
    );

    await settle();

    expect(container.querySelector(".meridian-definitions-continuation")).toBeNull();
  });
});
