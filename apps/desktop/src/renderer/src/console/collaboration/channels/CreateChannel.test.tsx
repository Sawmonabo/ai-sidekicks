// The create panel says what creation fixes and admits it cannot perform one.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CreateChannel } from "./CreateChannel.js";

describe("creating a channel — the standing statement", () => {
  it("says the settings cannot be edited afterwards", () => {
    const { container } = render(<CreateChannel />);
    expect(container.textContent ?? "").toContain("cannot be edited after it is created");
  });

  it("names each decision creation settles", () => {
    const { container } = render(<CreateChannel />);
    const labels = [...container.querySelectorAll(".meridian-create-channel__decision-label")].map(
      (element) => element.textContent ?? "",
    );
    expect(labels).toStrictEqual(["Name", "Who it is for", "How agents take turns"]);
  });
});

describe("creating a channel — the absence", () => {
  it("says nobody asked, rather than that nothing came back", () => {
    // `not-checked` and not `empty`: the console never put the question, because no
    // transport registers a call to put it with. Conflating those is exactly what
    // the five kinds of nothing exist to prevent.
    const { container } = render(<CreateChannel />);
    expect(container.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
    expect(container.querySelector(".meridian-nothing--empty")).toBeNull();
    expect(container.querySelector(".meridian-nothing--error")).toBeNull();
  });

  it("offers no control and collects no value", () => {
    // A field whose value can go nowhere reads as a broken feature, and a disabled
    // submit makes the same claim with a tooltip.
    const { container } = render(<CreateChannel />);
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.querySelectorAll("input")).toHaveLength(0);
    expect(container.querySelectorAll("select")).toHaveLength(0);
    expect(container.querySelectorAll("form")).toHaveLength(0);
  });

  it("negative control: it does render something, rather than nothing at all", () => {
    const { container } = render(<CreateChannel />);
    expect(container.querySelector(".meridian-create-channel")).not.toBeNull();
  });
});
