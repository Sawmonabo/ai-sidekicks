// What the disclosure says about a deployment it can and cannot read, and the four
// bounds it always states.
//
// The source sentence is the case that matters: an operator override replaces the
// allow-list wholesale, so a disclosure that showed a list without saying which of the
// two it is would be a hint about a deployment the console cannot see.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ATTACHMENTS_PER_CARRIER_CAP_DEFAULT } from "../../core/index.js";
import { AttachmentBoundsDisclosure } from "./AttachmentBoundsDisclosure.js";
import { SHIPPED_DEFAULT_ALLOWLIST } from "./attachment-bounds.js";
import { ATTACHMENT_ALLOWLIST_DEFAULT } from "./attachment-policy.js";

describe("attachment bounds disclosure — which list a user is looking at", () => {
  it("says the shipped default is not necessarily this deployment's list", () => {
    const { container } = render(
      <AttachmentBoundsDisclosure allowlist={SHIPPED_DEFAULT_ALLOWLIST} />,
    );
    const source = container.querySelector(".meridian-ingest-bounds__source")?.textContent ?? "";
    expect(source).toContain("shipped default");
    expect(source).toContain("wholesale");
  });

  it("says the effective list is the daemon's own where one was read", () => {
    const { container } = render(
      <AttachmentBoundsDisclosure
        allowlist={{
          source: "effective",
          mediaTypes: ["text/plain"],
          maximumByteLength: 1024,
          refusal: undefined,
        }}
      />,
    );
    const source = container.querySelector(".meridian-ingest-bounds__source")?.textContent ?? "";
    expect(source).toContain("effective allow-list");
    expect(source).not.toContain("shipped default");
  });

  it("carries the refusal that kept the effective read from answering", () => {
    const { container } = render(
      <AttachmentBoundsDisclosure
        allowlist={{
          ...SHIPPED_DEFAULT_ALLOWLIST,
          refusal: {
            code: "growth.unavailable",
            detail: "The attachment allow-list read is not registered on the bridge.",
            origin: "growth-port",
          },
        }}
      />,
    );
    expect(container.querySelector(".meridian-ingest-bounds__refusal")?.textContent).toContain(
      "growth.unavailable",
    );
  });

  it("negative control: a reading with no refusal draws no refusal region at all", () => {
    // Without this the case above would pass against a disclosure that printed the
    // region whatever the reading carried.
    const { container } = render(
      <AttachmentBoundsDisclosure allowlist={SHIPPED_DEFAULT_ALLOWLIST} />,
    );
    expect(container.querySelector(".meridian-ingest-bounds__refusal")).toBeNull();
  });
});

describe("attachment bounds disclosure — the four bounds", () => {
  it("renders every admitted media type, and no more than the list holds", () => {
    const { container } = render(
      <AttachmentBoundsDisclosure allowlist={SHIPPED_DEFAULT_ALLOWLIST} />,
    );
    expect(container.querySelectorAll(".meridian-ingest-bounds__types li")).toHaveLength(
      ATTACHMENT_ALLOWLIST_DEFAULT.length,
    );
  });

  it("states all four bounds, each with its own term", () => {
    const { container } = render(
      <AttachmentBoundsDisclosure allowlist={SHIPPED_DEFAULT_ALLOWLIST} />,
    );
    const caps = container.querySelector(".meridian-ingest-bounds__caps")?.textContent ?? "";
    expect(caps).toContain("Per attachment");
    expect(caps).toContain("Per carrier");
    expect(caps).toContain("Per chunk");
    expect(caps).toContain("Per upload");
    expect(caps).toContain(`${String(ATTACHMENTS_PER_CARRIER_CAP_DEFAULT)} attachments`);
    expect(caps).toContain("six hours");
  });

  it("says what happens at the count bound, ahead of the refusal that says it", () => {
    // Row 115's gap: the behaviour held, and no copy anywhere stated that the whole
    // carrier is refused while every artifact an earlier ingest minted survives.
    const { container } = render(
      <AttachmentBoundsDisclosure allowlist={SHIPPED_DEFAULT_ALLOWLIST} />,
    );
    const consequence =
      container.querySelector(".meridian-ingest-bounds__consequence")?.textContent ?? "";
    expect(consequence).toContain("whole carrier");
    expect(consequence).toContain("untouched");
  });
});
