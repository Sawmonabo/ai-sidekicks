// The facet builders: what each one accepts, and what it refuses.
//
// The refusals are the point. Every builder takes `unknown`, because the body it
// reads is a renderer-local map no projector has written yet, and a builder that
// coerced would put a figure on screen for a member the console never received.
// So each clean case below is paired with the input that must NOT produce it.

import { describe, expect, it } from "vitest";

import type { ConsoleEntity } from "../../../store/index.js";
import {
  byteFacet,
  countAttributedTo,
  countFacet,
  composedCountFacet,
  expiryFacet,
  instantFacet,
  readBodyMember,
  wireFacet,
} from "./entity-facets.js";

const INSTANT = "2026-01-01T16:30:05.000Z";

function entityWithBody(body: Readonly<Record<string, unknown>>): ConsoleEntity {
  return { kind: "run", id: "run-1", body };
}

describe("reading a kind-specific body member", () => {
  it("answers the stored value", () => {
    expect(readBodyMember(entityWithBody({ runVersion: 4 }), "runVersion")).toBe(4);
  });

  it("negative control: answers undefined for an entity that carries no body at all", () => {
    // Without this, every builder case below could be passing because
    // `readBodyMember` happened to return a truthy constant.
    expect(readBodyMember({ kind: "run", id: "run-1" }, "runVersion")).toBeUndefined();
    expect(readBodyMember(undefined, "runVersion")).toBeUndefined();
  });
});

describe("a wire string", () => {
  it("is carried verbatim in the wire form", () => {
    expect(wireFacet("Role", "owner", "role").value).toStrictEqual({
      form: "wire",
      text: "owner",
    });
  });

  it("negative control: a number, and an empty string, are not recorded", () => {
    expect(wireFacet("Role", 7, "role").value.form).toBe("unrecorded");
    expect(wireFacet("Role", "", "role").value.form).toBe("unrecorded");
  });

  it("names the member it did not find", () => {
    const value = wireFacet("Role", undefined, "role").value;
    expect(value.form === "unrecorded" ? value.detail : "").toContain("role");
  });
});

describe("a count", () => {
  it("goes through the figures chokepoint rather than a template literal", () => {
    expect(countFacet("Run version", 12000, "run version").value).toStrictEqual({
      form: "derived",
      text: new Intl.NumberFormat().format(12000),
    });
  });

  it("negative control: a numeric string is not a number", () => {
    expect(countFacet("Run version", "12", "run version").value.form).toBe("unrecorded");
  });

  it("negative control: an infinity is refused rather than rendered", () => {
    expect(countFacet("Run version", Number.POSITIVE_INFINITY, "run version").value.form).toBe(
      "unrecorded",
    );
  });

  it("a composed count is always present, because the console did the counting", () => {
    expect(composedCountFacet("Runs", 0).value).toStrictEqual({
      form: "derived",
      text: new Intl.NumberFormat().format(0),
    });
  });
});

describe("a byte quantity", () => {
  it("is scaled by the one module that scales bytes", () => {
    const value = byteFacet("Size", 4096, "byte length").value;
    expect(value.form === "derived" ? value.text : "").toContain("KiB");
  });

  it("accepts zero, which is a real size", () => {
    expect(byteFacet("Size", 0, "byte length").value.form).toBe("derived");
  });

  it("negative control: a negative count is refused rather than shown as a size", () => {
    expect(byteFacet("Size", -1, "byte length").value.form).toBe("unrecorded");
  });
});

describe("an instant", () => {
  it("renders as a wall-clock reading", () => {
    const value = instantFacet("Last touched", INSTANT, "touch time").value;
    expect(value.form).toBe("derived");
    expect(value.form === "derived" ? value.text : "").not.toBe("—");
  });

  it("negative control: a string that is not an instant takes the absent arm, not an em dash", () => {
    const value = instantFacet("Last touched", "yesterday", "touch time").value;
    expect(value.form).toBe("unrecorded");
  });
});

describe("an expiry, which has three answers", () => {
  it("labels an explicit null as no expiry", () => {
    expect(expiryFacet("Expires", null, "expiry").value).toStrictEqual({
      form: "derived",
      text: "No expiry",
    });
  });

  it("renders a real expiry as the instant it is", () => {
    expect(expiryFacet("Expires", INSTANT, "expiry").value.form).toBe("derived");
  });

  it("negative control: an absent member is NOT no expiry", () => {
    // The whole reason this builder exists rather than `instantFacet`: a decision
    // that never lapses and a member nobody projected are different facts.
    expect(expiryFacet("Expires", undefined, "expiry").value.form).toBe("unrecorded");
  });
});

describe("counting what a session attributes to a participant", () => {
  const entities: Readonly<Record<string, ConsoleEntity>> = {
    "run-1": { kind: "run", id: "run-1", attributedTo: "participant-1" },
    "run-2": { kind: "run", id: "run-2", attributedTo: "participant-2" },
    "run-3": { kind: "run", id: "run-3", attributedTo: "participant-1" },
    "run-4": { kind: "run", id: "run-4" },
  };

  it("counts the rows attributed to that participant", () => {
    expect(countAttributedTo(entities, "participant-1")).toBe(2);
  });

  it("negative control: a participant nothing is attributed to counts zero, not everything", () => {
    expect(countAttributedTo(entities, "participant-9")).toBe(0);
    expect(countAttributedTo({}, "participant-1")).toBe(0);
  });
});
