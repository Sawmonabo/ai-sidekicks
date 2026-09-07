// The device fan-out: the one refusal that is an answer, and the three states behind
// a row that are not each other.
//
// The property worth the most is the authorization arm. `Spec-018` makes the
// aggregated summary the unauthorized-DEFAULT projection, so rendering
// `presence.permission_denied` as an error would put a failure tone on a correct
// reading — and would offer a retry for a question whose answer is settled by who the
// caller is. An empty device list is the other trap: it is a fact about a person, not
// a read that failed.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { growthUnavailable } from "../../bridge/index.js";
import {
  PRESENCE_DETAIL_ORIGIN,
  isPresenceDetailUnauthorized,
  presenceDetailRefusal,
  presenceDetailValue,
  type PresenceDetailReading,
} from "./presence-detail.js";
import { PresenceDeviceDetail } from "./PresenceDeviceDetail.js";

const SERVED: PresenceDetailReading = {
  kind: "answered",
  outcome: {
    status: "served",
    value: {
      participantId: "participant-priya",
      aggregateState: "idle",
      devices: [
        { deviceId: "device-desk", state: "idle", lastSeen: "2026-01-01T09:59:30.000Z" },
        { deviceId: "device-phone", state: "offline", lastSeen: "2026-01-01T09:50:00.000Z" },
      ],
    },
  },
};

const ON_NO_DEVICE: PresenceDetailReading = {
  kind: "answered",
  outcome: {
    status: "served",
    value: { participantId: "participant-noah", aggregateState: "offline", devices: [] },
  },
};

const UNAUTHORIZED: PresenceDetailReading = {
  kind: "unreadable",
  refusal: {
    origin: PRESENCE_DETAIL_ORIGIN,
    code: "presence.permission_denied",
    detail: "Per-device detail is withheld.",
  },
};

const NOT_REGISTERED: PresenceDetailReading = {
  kind: "answered",
  outcome: growthUnavailable("participantPresenceDetailRead"),
};

describe("presence detail — the readers", () => {
  it("carries the fan-out on a served answer and nothing on the others", () => {
    expect(presenceDetailValue(SERVED)?.devices).toHaveLength(2);
    expect(presenceDetailValue(undefined)).toBeUndefined();
    expect(presenceDetailValue(UNAUTHORIZED)).toBeUndefined();
  });

  it("recognises the authorization answer and no other code", () => {
    expect(isPresenceDetailUnauthorized(presenceDetailRefusal(UNAUTHORIZED))).toBe(true);
    // Negative control: an ordinary refusal is not the authorization answer, and
    // rendering it as one would tell a person they are not allowed to see something
    // the console simply could not ask about.
    expect(isPresenceDetailUnauthorized(presenceDetailRefusal(NOT_REGISTERED))).toBe(false);
    expect(isPresenceDetailUnauthorized(undefined)).toBe(false);
  });
});

describe("presence detail — what a row draws behind it", () => {
  it("renders the authorization answer as a sentence, with no refusal shape", () => {
    const { container } = render(
      <PresenceDeviceDetail reading={UNAUTHORIZED} aggregateOnTheRow="idle" />,
    );
    expect(container.querySelector(".meridian-inline-refusal")).toBeNull();
    expect(container.textContent ?? "").toContain("aggregated summary");
  });

  it("renders every other refusal in place, code and message verbatim", () => {
    const { container } = render(
      <PresenceDeviceDetail reading={NOT_REGISTERED} aggregateOnTheRow="idle" />,
    );
    expect(container.textContent ?? "").toContain("wire-unregistered");
  });

  it("draws each device, and an empty list as a fact rather than a failure", () => {
    const served = render(<PresenceDeviceDetail reading={SERVED} aggregateOnTheRow="idle" />);
    expect(served.container.querySelectorAll(".meridian-roster-detail__device")).toHaveLength(2);
    expect(served.container.textContent ?? "").toContain("device-phone");

    const empty = render(
      <PresenceDeviceDetail reading={ON_NO_DEVICE} aggregateOnTheRow="offline" />,
    );
    expect(empty.container.querySelector(".meridian-nothing--empty")).not.toBeNull();
    expect(empty.container.textContent ?? "").toContain("On no device");
  });

  it("says so when the two reads disagree, and keeps the row's answer", () => {
    // Two reads of one fact that disagree is itself worth seeing. The row's aggregate
    // is the one that stands; this line is what stops the disagreement being silent.
    const { container } = render(
      <PresenceDeviceDetail reading={SERVED} aggregateOnTheRow="online" />,
    );
    expect(container.querySelector(".meridian-roster-detail__disagreement")).not.toBeNull();
  });

  it("negative control: agreeing reads draw no such line", () => {
    const { container } = render(
      <PresenceDeviceDetail reading={SERVED} aggregateOnTheRow="idle" />,
    );
    expect(container.querySelector(".meridian-roster-detail__disagreement")).toBeNull();
  });

  it("says the read is in flight rather than showing no devices", () => {
    const { container } = render(
      <PresenceDeviceDetail reading={undefined} aggregateOnTheRow="idle" />,
    );
    expect(container.querySelector(".meridian-nothing--not-loaded")).not.toBeNull();
  });
});
