// The session-keyed hook must forward the holder's guarantee rather than spell a second one, and
// its vocabulary must be the session's. Anything more would duplicate
// `hooks/subject-scoped/useSubjectScopedState.test.tsx`. The bridges are real fixture bridges
// because the subject is bridge identity, and casts of `{}` would not prove the right reference.

import { act, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { createFixture } from "@test/helpers/fixture-bridge.js";
import { SessionStore } from "../session/session-store.js";
import { isCurrentSessionSubject } from "./session-subject.js";
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

  it("discards it when the BRIDGE moves under an unchanged session", () => {
    // The subject is the bridge, not the id: a reconnect, a second window's instance, or the
    // fixture's scenario switch replaces the transport while the address stays the same.
    let latest = "";
    let publishInto: (next: string) => void = () => {};
    const record = (value: string, publish: (next: string) => void): void => {
      latest = value;
      publishInto = publish;
    };
    const view = render(
      <SessionScopedValueProbe
        bridge={createFixture().bridge}
        sessionId="session-one"
        onRender={record}
      />,
    );
    act(() => {
      publishInto("answered through the retired transport");
    });
    expect(latest).toBe("answered through the retired transport");

    view.rerender(
      <SessionScopedValueProbe
        bridge={createFixture().bridge}
        sessionId="session-one"
        onRender={record}
      />,
    );
    expect(latest).toBe("seed");
  });
});

describe("isCurrentSessionSubject — both live objects, neither reduced to a name", () => {
  const bridge = createFixture().bridge;
  const sessionStore = new SessionStore({ sessionId: "session-one" });

  it("answers true only for the exact pair it was held for", () => {
    expect(isCurrentSessionSubject({ bridge, sessionStore }, bridge, sessionStore)).toBe(true);
  });

  it("answers false when the projection was rebuilt for the same session", () => {
    const rebuilt = new SessionStore({ sessionId: "session-one" });
    expect(isCurrentSessionSubject({ bridge, sessionStore }, bridge, rebuilt)).toBe(false);
  });

  it("answers false when the transport was replaced", () => {
    expect(
      isCurrentSessionSubject({ bridge, sessionStore }, createFixture().bridge, sessionStore),
    ).toBe(false);
  });

  it("negative control: comparing the session ids would call both of those current", () => {
    // Every object here names one session, so without this the cases above would not show
    // which comparison the predicate makes: comparing names would answer true for both.
    const rebuilt = new SessionStore({ sessionId: "session-one" });
    expect(rebuilt.sessionId).toBe(sessionStore.sessionId);
    expect(createFixture().bridge).not.toBe(bridge);
  });

  it("answers false where nothing is held, or where either side is unresolved", () => {
    expect(isCurrentSessionSubject(undefined, bridge, sessionStore)).toBe(false);
    expect(isCurrentSessionSubject({ bridge, sessionStore }, undefined, sessionStore)).toBe(false);
    expect(isCurrentSessionSubject({ bridge, sessionStore }, bridge, undefined)).toBe(false);
  });
});
