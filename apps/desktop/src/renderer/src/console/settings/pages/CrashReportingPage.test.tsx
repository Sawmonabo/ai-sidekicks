// What the crash-reporting copy must say, and the two things it must not.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CrashReportingPage } from "./CrashReportingPage.js";
import type { ConsoleBridge } from "../../bridge/index.js";

const CARRIER_UNAVAILABLE = {
  status: "unavailable",
  code: "wire-unregistered",
  detail: "not registered",
  origin: "growth-port",
};

function bridge(): ConsoleBridge {
  return {
    source: "fixture",
    growth: {
      shellConfigRead: () => Promise.resolve(CARRIER_UNAVAILABLE),
      shellConfigWrite: () => Promise.resolve(CARRIER_UNAVAILABLE),
    },
  } as unknown as ConsoleBridge;
}

describe("crash reporting", () => {
  it("is on until somebody turns it off", () => {
    const { container } = render(<CrashReportingPage bridge={bridge()} />);
    expect(
      container.querySelector(".meridian-settings-row__switch")?.getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("names each thing that is stripped, and the three process kinds it covers", () => {
    const { container } = render(<CrashReportingPage bridge={bridge()} />);
    const text = container.textContent ?? "";
    expect(text).toContain("stable hashes");
    expect(text).toContain("reduced to their extension");
    expect(text).toContain("no content payloads");
    expect(text).toContain("main process");
    expect(text).toContain("child and utility processes");
  });

  it("negative control: it never calls a report anonymous and names no recipient", () => {
    // Both are claims the corpus does not make — the sink is unsettled, and a stable
    // hash is not anonymity. This fails the moment a comfortable sentence arrives.
    const { container } = render(<CrashReportingPage bridge={bridge()} />);
    const text = (container.textContent ?? "").toLowerCase();
    // The word appears exactly once, inside the sentence that DENIES the claim.
    expect(text).toContain("not the same as being anonymous");
    expect(text).not.toContain("is anonymous");
    expect(text).not.toContain("fully anonymous");
    expect(text).not.toContain("anonymised");
    expect(text).not.toContain("anonymized");
    expect(text).not.toContain("sent to");
  });
});
