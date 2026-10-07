import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { drawnText } from "#test/helpers/live-region.js";
import { LiveAnnouncerProvider } from "../LiveAnnouncer/LiveAnnouncerProvider.js";
import { MathBlock } from "./MathBlock.js";

describe("a formula that does not typeset", () => {
  it("takes the source arm and says so, rather than a formula-shaped blank", async () => {
    // Under a KaTeX told not to throw, a parse error comes back as markup and would be recorded
    // as typeset, so the source would never appear.
    const { container } = render(<MathBlock source={String.raw`\frac{1`} isDisplayMode />, {
      wrapper: LiveAnnouncerProvider,
    });

    await waitFor(() => {
      expect(drawnText(container)).toContain("could not be typeset");
    });
    expect(container.querySelector(".meridian-math--source")).not.toBeNull();
    expect(container.querySelector("code")?.textContent).toBe(String.raw`\frac{1`);
    expect(container.querySelector("math")).toBeNull();
  });
});
