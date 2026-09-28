// The default route's screen: it draws its frame and never reaches for a binding.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SessionsSurface } from "./SessionsSurface.js";

describe("the sessions destination", () => {
  it("draws its heading with no attention binding above it and no sentence beside it", () => {
    const { container } = render(<SessionsSurface />);

    expect(screen.getByRole("region", { name: "Sessions" })).toBeDefined();
    expect(container.textContent).toBe("Sessions");
  });
});
