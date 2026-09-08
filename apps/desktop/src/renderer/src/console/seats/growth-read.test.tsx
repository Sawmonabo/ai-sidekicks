// The one growth read: asked once per subject, held against it, and answered on both
// arms a promise has.
//
// The three properties are the three ways surfaces got this wrong before it was one
// module. A read that re-asked on every render is an interval poll with no timer in
// it — the idle-CPU budget is measured against exactly that. A read whose rejection
// arm was left off went on rendering "still coming" for the life of the window over a
// call that had already failed. And a read that published under whichever subject was
// current when the answer arrived drew one session's answer under another's name.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ConsoleBridge, GrowthOutcome } from "../bridge/index.js";
import { useGrowthReadOnMount } from "./growth-read.js";

/** A bridge object identity and nothing else: this hook only ever keys on it. */
const BRIDGE = { source: "fixture" } as unknown as ConsoleBridge;
const OTHER_BRIDGE = { source: "fixture" } as unknown as ConsoleBridge;

interface Probe {
  readonly askCalls: string[];
  readonly settle: (value: string) => void;
  readonly reject: (reason: unknown) => void;
}

/**
 * A component that drives the hook and records what it asked.
 *
 * The REAL hook, driven through a real render tree — a stand-in for it would assert
 * nothing about the effect scheduling, which is the whole of what is under test.
 */
function ReadProbe(props: {
  readonly bridge: ConsoleBridge;
  readonly subject: string | undefined;
  readonly probe: Probe;
  readonly onReading: (reading: unknown) => void;
}): React.JSX.Element {
  const reading = useGrowthReadOnMount<{ readonly subject: string }, string>({
    bridge: props.bridge,
    subject: props.subject,
    // Rebuilt on every render, deliberately: an equal request under an unchanged
    // subject must re-ask nothing, and a fresh object each pass is what proves it.
    request: props.subject === undefined ? undefined : { subject: props.subject },
    origin: "probe",
    ask: async (_bridge, request) => {
      props.probe.askCalls.push(request.subject);
      return await new Promise<GrowthOutcome<string>>((resolve, reject) => {
        settleCurrent = (value) => {
          resolve({ status: "served", value });
        };
        rejectCurrent = reject;
      });
    },
  });
  props.onReading(reading);
  return <span>{reading === undefined ? "asking" : reading.kind}</span>;
}

let settleCurrent: (value: string) => void = () => undefined;
let rejectCurrent: (reason: unknown) => void = () => undefined;

function probeOf(): Probe {
  return {
    askCalls: [],
    settle: (value) => {
      settleCurrent(value);
    },
    reject: (reason) => {
      rejectCurrent(reason);
    },
  };
}

describe("growth read — asked once", () => {
  it("asks once for a subject, however many times the tree re-renders", async () => {
    const probe = probeOf();
    const { rerender } = render(
      <ReadProbe bridge={BRIDGE} subject="session-one" probe={probe} onReading={() => undefined} />,
    );
    rerender(
      <ReadProbe bridge={BRIDGE} subject="session-one" probe={probe} onReading={() => undefined} />,
    );
    rerender(
      <ReadProbe bridge={BRIDGE} subject="session-one" probe={probe} onReading={() => undefined} />,
    );
    await act(async () => {
      probe.settle("first");
    });
    expect(probe.askCalls).toStrictEqual(["session-one"]);
  });

  it("asks again when the subject moves, and never for an absent one", async () => {
    // The negative control for the case above: without this, a hook that asked once
    // ever would pass it and would answer the second session with the first's answer.
    const probe = probeOf();
    const { rerender } = render(
      <ReadProbe bridge={BRIDGE} subject={undefined} probe={probe} onReading={() => undefined} />,
    );
    expect(probe.askCalls).toStrictEqual([]);

    rerender(
      <ReadProbe bridge={BRIDGE} subject="session-one" probe={probe} onReading={() => undefined} />,
    );
    await act(async () => {
      probe.settle("first");
    });
    rerender(
      <ReadProbe bridge={BRIDGE} subject="session-two" probe={probe} onReading={() => undefined} />,
    );
    await act(async () => {
      probe.settle("second");
    });
    expect(probe.askCalls).toStrictEqual(["session-one", "session-two"]);
  });

  it("asks again for a replacement bridge on the same subject", async () => {
    // A window handed a replacement bridge for the same session is holding an answer
    // from a transport that no longer exists.
    const probe = probeOf();
    const { rerender } = render(
      <ReadProbe bridge={BRIDGE} subject="session-one" probe={probe} onReading={() => undefined} />,
    );
    await act(async () => {
      probe.settle("first");
    });
    rerender(
      <ReadProbe
        bridge={OTHER_BRIDGE}
        subject="session-one"
        probe={probe}
        onReading={() => undefined}
      />,
    );
    await act(async () => {
      probe.settle("second");
    });
    expect(probe.askCalls).toStrictEqual(["session-one", "session-one"]);
  });
});

describe("growth read — both arms of the call", () => {
  it("publishes the outcome the port resolved with", async () => {
    const probe = probeOf();
    const readings: unknown[] = [];
    render(
      <ReadProbe
        bridge={BRIDGE}
        subject="session-one"
        probe={probe}
        onReading={(reading) => {
          readings.push(reading);
        }}
      />,
    );
    await act(async () => {
      probe.settle("served-value");
    });
    expect(readings.at(-1)).toStrictEqual({
      kind: "answered",
      outcome: { status: "served", value: "served-value" },
    });
  });

  it("publishes a console refusal when the call rejects instead of answering", async () => {
    // Left unhandled, this arm publishes nothing and the surface renders its
    // not-loaded absence for the life of the window over a call that already failed.
    const probe = probeOf();
    const readings: unknown[] = [];
    render(
      <ReadProbe
        bridge={BRIDGE}
        subject="session-one"
        probe={probe}
        onReading={(reading) => {
          readings.push(reading);
        }}
      />,
    );
    await act(async () => {
      probe.reject(new Error("the bridge went away"));
    });
    const settled = readings.at(-1) as { kind: string; refusal: { origin: string } };
    expect(settled.kind).toBe("unreadable");
    expect(settled.refusal.origin).toBe("probe");
  });
});
