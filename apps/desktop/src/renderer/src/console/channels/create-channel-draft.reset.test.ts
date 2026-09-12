// What a settled create is allowed to clear, and what it must leave alone.
//
// A suite beside `create-channel-draft.test.ts` rather than inside it, on this package's
// size gate and on the split it enforces: that file decides what goes ON THE WIRE, and
// this one decides what happens to the form afterwards. They are two jobs over one class.
//
// THE DEFECT THESE CASES EXIST FOR. A served create emptied the form unconditionally, and
// a create is a round trip whose length this console does not decide. The fields stay
// live for it — a text box that went dead mid-trip would drop keystrokes a person had
// already committed — so everything typed while one was out was thrown away the moment
// the receipt landed, with the receipt on screen as the explanation.

import { describe, expect, it } from "vitest";

import type { CreateChannelDraft } from "./create-channel-draft.js";
import { CHANNEL_MODERATION_FIELDS, draftSnapshotsMatch } from "./create-channel-fields.js";
import { namedDraft } from "./create-channel-draft.test-support.js";

describe("create channel draft — what a settled create is allowed to clear", () => {
  /**
   * Every way a person can move a draft, one per field the snapshot carries.
   *
   * The moderation members come off their own tuple, so the table is closed against the
   * form's vocabulary rather than hand-listed — and the case below asserts the WIDTH
   * against the snapshot's own shape, so a fifth field arrives here or fails.
   */
  const DRAFT_EDITS: readonly {
    readonly field: string;
    readonly apply: (draft: CreateChannelDraft) => void;
  }[] = [
    { field: "name", apply: (draft) => draft.setName("review two") },
    { field: "audience", apply: (draft) => draft.setAudience("humans-only") },
    { field: "turnsPerAgent", apply: (draft) => draft.setTurnsPerAgent("2") },
    ...CHANNEL_MODERATION_FIELDS.map((field) => ({
      field,
      apply: (draft: CreateChannelDraft) => {
        draft.setModeration(field, true);
      },
    })),
  ];

  it("empties a draft nothing has been typed into since it was sent", () => {
    const draft = namedDraft();
    const submitted = draft.snapshot();

    expect(draft.resetIfUnchangedSince(submitted)).toBe(true);
    expect(draft.name).toBe("");
  });

  it("leaves a draft that moved on exactly where the person left it", () => {
    // The defect this rule exists for. A create is a round trip whose length the console
    // does not decide and the fields stay live for it, so the keystrokes that land while
    // one is out are the person's NEXT channel — and clearing them is this surface taking
    // work away as a reward for the work it just finished.
    const draft = namedDraft();
    const submitted = draft.snapshot();
    draft.setName("the next one");

    expect(draft.resetIfUnchangedSince(submitted)).toBe(false);
    expect(draft.name).toBe("the next one");
  });

  it("notices a change to any field a person can touch, and to no field twice", () => {
    // The comparison is only worth anything if it walks every member: one field left out
    // is one edit a settled create silently throws away, and it would be the field
    // nobody thought to test.
    expect(DRAFT_EDITS.length).toBe(
      Object.keys(namedDraft().snapshot()).length - 1 + CHANNEL_MODERATION_FIELDS.length,
    );
    expect(new Set(DRAFT_EDITS.map((edit) => edit.field)).size).toBe(DRAFT_EDITS.length);

    for (const edit of DRAFT_EDITS) {
      const draft = namedDraft();
      const submitted = draft.snapshot();
      edit.apply(draft);
      expect(`${edit.field}: ${String(draft.resetIfUnchangedSince(submitted))}`).toBe(
        `${edit.field}: false`,
      );
    }
  });

  it("reads a field put back where it was as no change at all", () => {
    // Value comparison and not a touched-flag: a person who typed and then undid it has
    // the draft they sent, so the create it settles may clear it.
    const draft = namedDraft();
    const submitted = draft.snapshot();
    draft.setName("a detour");
    draft.setName("review");

    expect(draft.resetIfUnchangedSince(submitted)).toBe(true);
  });

  it("negative control: two readings of one untouched draft are the same reading", () => {
    // Without this every case above would pass over a comparison that answered "changed"
    // for everything — which would make the reset unreachable and look like a working
    // guard. A snapshot is composed fresh each time it is taken, so identity is exactly
    // what must not be compared.
    const draft = namedDraft();

    expect(draftSnapshotsMatch(draft.snapshot(), draft.snapshot())).toBe(true);
  });
});
