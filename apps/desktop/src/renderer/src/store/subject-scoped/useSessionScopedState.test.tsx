// The session-keyed hook must forward the holder's guarantee: one session's value never reaches
// another. The bridge is a real fixture bridge because the subject is bridge identity.

import { act, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { createFixture } from "@test/helpers/fixture-bridge.js";
import { useSessionScopedState } from "./useSessionScopedState.js";

interface SessionScopedValueProbeProps {
  readonly bridge: object;
  readonly sessionId: string | undefined;
  readonly onRender: (value: string, publish: (next: string) => void) => void;
}

function SessionScopedValueProbe(props: SessionScopedValueProbeProps): ReactElement {
  const { value, publish } = useSessionScopedState<string>(
    props.bridge,
    props.sessionId,
    () => "seed",
  );
  props.onRender(value, publish);
  return <output>{value}</output>;
}

describe("useSessionScopedState — the session-keyed hook forwards, and holds nothing", () => {
  it("keeps a value across a re-render and discards it when the session moves", () => {
    const bridge = createFixture().bridge;
    let latest = "";
    let publishInto: (next: string) => void = () => {};
    const view = render(
      <SessionScopedValueProbe
        bridge={bridge}
        sessionId="session-one"
        onRender={(value, publish) => {
          latest = value;
          publishInto = publish;
        }}
      />,
    );
    act(() => {
      publishInto("session one's answer");
    });
    expect(latest).toBe("session one's answer");

    view.rerender(
      <SessionScopedValueProbe
        bridge={bridge}
        sessionId="session-two"
        onRender={(value, publish) => {
          latest = value;
          publishInto = publish;
        }}
      />,
    );
    expect(latest).toBe("seed");
  });
});
