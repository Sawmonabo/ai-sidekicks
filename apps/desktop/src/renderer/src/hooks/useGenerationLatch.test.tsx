import { act, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { useGenerationLatch } from "./useGenerationLatch.js";
import type { GenerationLatch } from "@renderer/lib/reads/generation-latch.js";
import { SUBJECT_ONE } from "@test/helpers/subject-fixtures.js";

interface LatchProbeProps {
  readonly onReady: (latch: GenerationLatch) => void;
}

function LatchProbe(props: LatchProbeProps): ReactElement {
  props.onReady(useGenerationLatch());
  return <output>latched</output>;
}

describe("useGenerationLatch — one register per mount", () => {
  it("supersedes every outstanding claim when the component unmounts", () => {
    let latch: GenerationLatch | undefined;
    const view = render(
      <LatchProbe
        onReady={(mounted) => {
          latch = mounted;
        }}
      />,
    );
    const claim = latch?.claim(SUBJECT_ONE, "compact");
    expect(claim?.isCurrent).toBe(true);
    act(() => {
      view.unmount();
    });
    expect(claim?.isCurrent).toBe(false);
    expect(claim?.settle(() => undefined)).toBe(false);
  });

  it("hands a second mount a register the first one's claims cannot reach", () => {
    let firstLatch: GenerationLatch | undefined;
    let secondLatch: GenerationLatch | undefined;
    const first = render(
      <LatchProbe
        onReady={(mounted) => {
          firstLatch = mounted;
        }}
      />,
    );
    const abandoned = firstLatch?.claim(SUBJECT_ONE, "compact");
    act(() => {
      first.unmount();
    });
    render(
      <LatchProbe
        onReady={(mounted) => {
          secondLatch = mounted;
        }}
      />,
    );
    expect(secondLatch).not.toBe(firstLatch);
    expect(secondLatch?.claim(SUBJECT_ONE, "compact")).toBeDefined();
    expect(abandoned?.settle(() => undefined)).toBe(false);
  });
});
