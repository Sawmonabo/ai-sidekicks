// The session-named door, and the pair predicate beside it.
//
// A door earns two tests and no more: that it FORWARDS — the guarantee it names is
// the one the holder makes, not a second one spelled here — and that its vocabulary
// is the session's. Anything else asserted here would be a second copy of
// `store/subject-scoped-state.test.tsx`, which is the drift this door exists to
// prevent.
//
// The bridges are real fixture bridges rather than shaped objects: the door's whole
// subject is bridge IDENTITY, and two casts of `{}` would prove the door compares
// references without proving it compares the reference a caller actually holds. They
// come from `bridge/`'s own test-support module rather than from a builder written
// here — a suite that wraps `createFixtureBridge` itself is a second answer to what
// "the fixture bridge" is, and the two drift the day the scenario default moves.

import { act, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { createFixture } from "../bridge/fixture-bridge.test-support.js";
import type { ConsoleBridge } from "../bridge/index.js";
import { SessionStore } from "../store/index.js";
import { isCurrentSessionSubject, useSessionScopedState } from "./session-subject.js";

interface DoorProbeProps {
  readonly bridge: ConsoleBridge;
  readonly sessionId: string | undefined;
  readonly onRender: (value: string, publish: (next: string) => void) => void;
}

function DoorProbe(props: DoorProbeProps): ReactElement {
  const { value, publish } = useSessionScopedState<string>(
    props.bridge,
    props.sessionId,
    () => "seed",
  );
  props.onRender(value, publish);
  return <output>{value}</output>;
}

describe("useSessionScopedState — the session-named door forwards, and holds nothing", () => {
  it("keeps a value across a re-render and discards it when the session moves", () => {
    const bridge = createFixture().bridge;
    let latest = "";
    let publishInto: (next: string) => void = () => {};
    const view = render(
      <DoorProbe
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
      <DoorProbe
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
    // The reason the door's subject is the bridge and not the id: a reconnect, a
    // second window's own instance, or the fixture's scenario switch replaces the
    // transport while the session on the address stays exactly what it was.
    let latest = "";
    let publishInto: (next: string) => void = () => {};
    const record = (value: string, publish: (next: string) => void): void => {
      latest = value;
      publishInto = publish;
    };
    const view = render(
      <DoorProbe bridge={createFixture().bridge} sessionId="session-one" onRender={record} />,
    );
    act(() => {
      publishInto("answered through the retired transport");
    });
    expect(latest).toBe("answered through the retired transport");

    view.rerender(
      <DoorProbe bridge={createFixture().bridge} sessionId="session-one" onRender={record} />,
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
    // Without this, the two cases above would prove nothing about WHICH comparison
    // the predicate performs — every object in them names one session throughout, so
    // a predicate that read the name would answer `true` where these answer `false`.
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
