// The state one form holds: where a value lands, what a list does when an entry leaves,
// and which of the two input modes the answer is read from.
//
// The list case is the one worth writing down. Removing the middle entry of three has to
// renumber the answer, because the entries are positions and the position is the name —
// a hole left at index one would leave the third entry called "3" while the answer carried
// it second, and the schema would then report a finding against a control nobody is
// looking at.
//
// AND THE DEFAULTED SCHEMA IS THE OTHER ONE. A member the schema fills in for itself is
// where the composed answer and the checked answer come apart: the three cases over it
// pin that the value sent is the one the schema accepted, that the control shows it, and
// that answering the member replaces it rather than the other way round.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useSchemaForm, type SchemaFormState } from "./use-schema-form.js";
import { isSameMemberPath } from "../../bridge/index.js";

afterEach(cleanup);

/** Mount the hook and hand back a live handle on its latest state. */
function mountForm(inputSchema: unknown): () => SchemaFormState {
  let latest: SchemaFormState | undefined;
  function Probe(): React.JSX.Element {
    latest = useSchemaForm(inputSchema);
    return <div />;
  }
  render(<Probe />);
  return () => {
    if (latest === undefined) {
      throw new Error("the hook never rendered");
    }
    return latest;
  };
}

/** A schema that fills one member in for itself, and leaves the other to a person. */
const DEFAULTED_SCHEMA = {
  type: "object",
  properties: { approver: { type: "string", default: "ada" }, note: { type: "string" } },
  required: ["approver"],
} as const;

/** A schema that fills one member in for itself while REQUIRING one it does not. */
const PARTLY_DEFAULTED_SCHEMA = {
  type: "object",
  properties: { approver: { type: "string", default: "ada" }, note: { type: "string" } },
  required: ["note"],
} as const;

/** A schema asking one mandatory yes-or-no and declaring no value for it. */
const REQUIRED_BOOLEAN_SCHEMA = {
  type: "object",
  properties: { approved: { type: "boolean", title: "Approved" } },
  required: ["approved"],
} as const;

/** A schema whose members exercise a nested write and a list. */
const NESTED_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    release: { type: "object", properties: { tag: { type: "string" } }, required: ["tag"] },
    reviewers: { type: "array", items: { type: "string" } },
  },
  required: ["title"],
} as const;

describe("the schema form's state", () => {
  it("writes a top-level member into the answer", () => {
    const form = mountForm(NESTED_SCHEMA);

    act(() => {
      form().setMemberValue(["title"], "Ship it");
    });

    expect(form().memberValue(["title"])).toBe("Ship it");
    // The drawn collection is in the answer from the mount, because it is on the screen
    // from the mount: an empty list is what its control is already showing.
    expect(form().answer).toEqual({ title: "Ship it", reviewers: [] });
  });

  it("writes a member one level down without disturbing its siblings", () => {
    const form = mountForm(NESTED_SCHEMA);

    act(() => {
      form().setMemberValue(["title"], "Ship it");
    });
    act(() => {
      form().setMemberValue(["release", "tag"], "v2");
    });

    expect(form().answer).toEqual({ title: "Ship it", release: { tag: "v2" }, reviewers: [] });
  });

  it("keeps a list in order when an entry leaves the middle of it", () => {
    const form = mountForm(NESTED_SCHEMA);

    for (const name of ["ada", "bela", "cyd"]) {
      act(() => {
        form().appendListItem(["reviewers"]);
      });
      act(() => {
        form().setListItem(["reviewers"], form().listItems(["reviewers"]).length - 1, name);
      });
    }
    act(() => {
      form().removeListItem(["reviewers"], 1);
    });

    expect(form().listItems(["reviewers"])).toEqual(["ada", "cyd"]);
  });

  it("reads the schema's verdict on the drawn answer and clears it once the answer is whole", () => {
    const form = mountForm(NESTED_SCHEMA);

    expect(form().report?.status).toBe("invalid");
    expect(
      form().report?.issues.some((issue) => isSameMemberPath(issue.memberPath, ["title"])),
    ).toBe(true);

    act(() => {
      form().setMemberValue(["title"], "Ship it");
    });
    act(() => {
      form().setMemberValue(["release", "tag"], "v2");
    });

    expect(form().report?.status).toBe("valid");
  });

  it("submits the value the schema accepted, and opens its controls holding it", () => {
    // The divergence this closes: the reader supplies a member declaring a default, so
    // `{}` is valid — and a form that sent `{}` while showing a blank control would put
    // a clean verdict beside bytes nobody could see and nobody chose.
    const form = mountForm(DEFAULTED_SCHEMA);

    expect(form().report?.status).toBe("valid");
    expect(form().answer).toEqual({ approver: "ada" });
    // And on the control, not only on the wire: the seed is what a person reads.
    expect(form().memberValue(["approver"])).toBe("ada");
  });

  it("negative control: a member the schema declares no value for opens empty", () => {
    // Without this, the case above would hold over a form that pre-filled every control
    // with something — the seed has to be the schema's own reading and nothing else.
    const form = mountForm(DEFAULTED_SCHEMA);

    expect(form().memberValue(["note"])).toBeUndefined();
  });

  it("carries a typed answer over the schema's own value for that member", () => {
    // The other half of the seed: it is a starting value and never an override, so
    // answering the member replaces it rather than being replaced by it.
    const form = mountForm(DEFAULTED_SCHEMA);

    act(() => {
      form().setMemberValue(["approver"], "bela");
    });

    expect(form().answer).toEqual({ approver: "bela" });
  });

  it("seeds a member's own default while a different member is still unanswered", () => {
    // The all-or-nothing seed's failure: `{}` is refused because `note` is missing, so a
    // schema that DID declare a value for `approver` opened that control blank — and the
    // value reappeared in the submission the moment the unrelated member was answered.
    const form = mountForm(PARTLY_DEFAULTED_SCHEMA);

    expect(form().report?.status).toBe("invalid");
    expect(form().memberValue(["approver"])).toBe("ada");
    expect(form().answer).toEqual({ approver: "ada" });
  });

  it("negative control: the answer holds no member the controls are not showing", () => {
    // The property the seed exists for, asserted over the answer rather than over one
    // member: every member a submission would carry is readable from a control.
    const form = mountForm(PARTLY_DEFAULTED_SCHEMA);

    act(() => {
      form().setMemberValue(["note"], "looks good");
    });

    expect(form().report?.status).toBe("valid");
    const answer = form().answer as Record<string, unknown>;
    for (const memberKey of Object.keys(answer)) {
      expect(form().memberValue([memberKey])).toEqual(answer[memberKey]);
    }
    expect(answer).toEqual({ approver: "ada", note: "looks good" });
  });

  it("answers a required yes-or-no with the false its box is already showing", () => {
    // An unchecked box is not a blank one: it says no. Submitting immediately therefore
    // carries `false` rather than nothing, and expressing it costs no second toggle.
    const form = mountForm(REQUIRED_BOOLEAN_SCHEMA);

    expect(form().memberValue(["approved"])).toBe(false);
    expect(form().answer).toEqual({ approved: false });
    expect(form().report?.status).toBe("valid");
  });

  it("answers an optional yes-or-no the same way, since the box reads the same", () => {
    const form = mountForm({ type: "object", properties: { subscribe: { type: "boolean" } } });

    expect(form().answer).toEqual({ subscribe: false });
  });

  it("opens a yes-or-no at the value its schema declared", () => {
    const form = mountForm({
      type: "object",
      properties: { approved: { type: "boolean", default: true } },
    });

    expect(form().memberValue(["approved"])).toBe(true);
    expect(form().answer).toEqual({ approved: true });
  });

  it("negative control: a text member the schema declares no value for stays absent", () => {
    // The seed is the schema's declared values plus the one state a box cannot leave
    // blank — never a value invented for every control, which would submit `note: \"\"`
    // for a member nobody answered.
    const form = mountForm(PARTLY_DEFAULTED_SCHEMA);

    expect(form().memberValue(["note"])).toBeUndefined();
    expect(form().answer).not.toHaveProperty("note");
  });

  it("adds a yes-or-no list entry as the false its box shows", () => {
    const form = mountForm({
      type: "object",
      properties: { flags: { type: "array", items: { type: "boolean" } } },
    });

    act(() => {
      form().appendListItem(["flags"]);
    });

    expect(form().listItems(["flags"])).toEqual([false]);
  });

  it("adds a repeated number entry the schema reads as unanswered rather than as text", () => {
    const form = mountForm({
      type: "object",
      properties: { scores: { type: "array", items: { type: "number" } } },
    });

    act(() => {
      form().appendListItem(["scores"]);
    });

    // The control shows a blank number box, so the answer holds no value for it — and the
    // schema reports the entry rather than accepting a string the box cannot display.
    expect(form().listItems(["scores"])).toEqual([undefined]);
    expect(form().report?.status).toBe("invalid");
    expect(
      form().report?.issues.some((issue) => isSameMemberPath(issue.memberPath, ["scores", 0])),
    ).toBe(true);
  });

  it("answers a required collection that accepts none with the empty list it is showing", () => {
    // Before, the member was omitted while the control drew an empty collection, so a
    // required array legally satisfied by zero entries opened invalid and could only be
    // submitted by adding an entry and taking it away again.
    const form = mountForm({
      type: "object",
      properties: { reviewers: { type: "array", items: { type: "string" } } },
      required: ["reviewers"],
    });

    expect(form().listItems(["reviewers"])).toEqual([]);
    expect(form().answer).toEqual({ reviewers: [] });
    expect(form().report?.status).toBe("valid");
  });

  it("opens a control at the value its enclosing group declared for it", () => {
    const form = mountForm({
      type: "object",
      properties: {
        release: {
          type: "object",
          default: { tag: "v1" },
          properties: { tag: { type: "string" } },
        },
      },
    });

    // Read off the CONTROL and not only off the answer: the value reaches the submission
    // by being visible in the control it belongs to, which is this seed's whole rule.
    expect(form().memberValue(["release", "tag"])).toBe("v1");
    expect(form().answer).toEqual({ release: { tag: "v1" } });
  });

  it("negative control: a text list entry is still added empty rather than as false", () => {
    const form = mountForm(NESTED_SCHEMA);

    act(() => {
      form().appendListItem(["reviewers"]);
    });

    expect(form().listItems(["reviewers"])).toEqual([""]);
  });

  it("opens a member one level down at the value its own schema declared", () => {
    const form = mountForm({
      type: "object",
      properties: {
        release: { type: "object", properties: { tag: { type: "string", default: "v1" } } },
      },
    });

    expect(form().memberValue(["release", "tag"])).toBe("v1");
    expect(form().answer).toEqual({ release: { tag: "v1" } });
  });

  it("opens a list holding the entries its schema declared", () => {
    const form = mountForm({
      type: "object",
      properties: { reviewers: { type: "array", items: { type: "string" }, default: ["ada"] } },
    });

    expect(form().listItems(["reviewers"])).toEqual(["ada"]);
    expect(form().answer).toEqual({ reviewers: ["ada"] });
  });

  it("reads the answer off the raw text when the schema drew no controls", () => {
    const form = mountForm({ type: "string" });

    expect(form().plan.shape).toBe("raw");

    act(() => {
      form().setRawText('{"anything": 1}');
    });

    expect(form().rawReading).toEqual({ status: "parsed", answer: { anything: 1 } });
    expect(form().answer).toEqual({ anything: 1 });
  });

  it("reports unparsable raw text as a syntax reading rather than as an answer", () => {
    const form = mountForm({ type: "string" });

    act(() => {
      form().setRawText("{not json");
    });

    expect(form().rawReading.status).toBe("unparsable");
    expect(form().answer).toBeUndefined();
    // No verdict at all, because there is nothing to check yet — and never a verdict of
    // `valid`, which would say the answer satisfied a schema it was never handed to.
    expect(form().report).toBeUndefined();
  });

  it("holds no verdict at all when the schema itself could not be compiled", () => {
    const form = mountForm({ type: "object", properties: { a: { $ref: "#/definitions/x" } } });

    expect(form().validator.status).toBe("uncompilable");
    expect(form().report).toBeUndefined();
  });

  it("reads the answer off the raw text when the drawable schema compiled nowhere", () => {
    // The mapper is happy with this member; the schema READER refuses the root. An arm
    // chosen from the mapper alone drew controls whose answer nothing would ever check —
    // so what this pins is where the answer COMES FROM, which is the half a test of the
    // drawn markup cannot reach.
    const form = mountForm({
      type: "object",
      properties: { title: { type: "string" } },
      if: { properties: { title: { const: "urgent" } } },
      then: { required: ["title"] },
    });
    const plan = form().plan;

    expect(form().validator.status).toBe("uncompilable");
    expect(plan.shape === "raw" ? plan.fallback.cause : undefined).toBe("schema-uncheckable");

    act(() => {
      form().setRawText('{"title": "Ship it"}');
    });

    expect(form().answer).toEqual({ title: "Ship it" });
  });
});
