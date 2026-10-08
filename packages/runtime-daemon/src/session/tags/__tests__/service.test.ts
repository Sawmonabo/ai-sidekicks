// A tag is one tag under every casing. Each verb runs through the real writer on a real database,
// and every assertion reads the rows back.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import {
  openScratchDatabase,
  type ScratchDatabase,
} from "../../../database/__fixtures__/scratch.js";
import { mintSessionId, seedSessionRow } from "../../directory/__fixtures__/directory-rows.js";
import { SessionTagService } from "../service.js";

let scratch: ScratchDatabase;
let tags: SessionTagService;
let sessionId: SessionId;

beforeEach(async () => {
  scratch = await openScratchDatabase();
  tags = new SessionTagService(scratch);
  sessionId = mintSessionId();
  await seedSessionRow(scratch.writer, sessionId);
});

afterEach(async () => {
  await scratch.close();
});

function storedTags(): { tag: string; tag_folded: string }[] {
  return scratch.reader
    .prepare("SELECT tag, tag_folded FROM session_tags ORDER BY tag_folded")
    .all() as { tag: string; tag_folded: string }[];
}

describe("a session tag", () => {
  it("nests with a slash and is one tag under every casing", async () => {
    await tags.add({ sessionId, tag: "Billing/Stripe" });
    await tags.add({ sessionId, tag: "billing/STRIPE" });
    expect(storedTags()).toEqual([{ tag: "Billing/Stripe", tag_folded: "billing/stripe" }]);
    expect(tags.list()).toEqual({ tags: ["Billing/Stripe"] });

    await tags.remove({ sessionId, tag: "BILLING/stripe" });
    expect(storedTags()).toEqual([]);
  });
});
