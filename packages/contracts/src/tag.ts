// The one tag rule every tagged record follows: what a tag may hold, and how a list of tags holds
// each tag once.
import { z } from "zod";

import { wireFreeFormString } from "./free-form-string.js";
import { findRepeats } from "./internal/repeats.js";
import { foldName } from "./name-fold.js";
import { SESSION_NAME_MAX_LEN } from "./session/name.js";

/**
 * One tag, nested with `/` (`billing/stripe`): never empty, no whitespace anywhere, no empty level
 * around a `/` (`/billing`, `billing//stripe`, `billing/`), and no longer than a session name.
 */
export const TagSchema: z.ZodType<string, string> = wireFreeFormString(
  SESSION_NAME_MAX_LEN,
  "A tag",
)
  .refine((tag) => !/\s/u.test(tag), { message: "A tag holds no whitespace." })
  .refine((tag) => tag.split("/").every((level) => level.length > 0), {
    message: "A tag has no empty level around a /.",
  })
  .describe("A tag, nested with /: no whitespace, never empty, and no empty level around a /.");

/**
 * A record's tags, each held once: two tags that differ only in case (`Ops`, `ops`) are one tag,
 * compared by {@link foldName}. The type cannot say the tags are distinct; the schema refuses a
 * repeat at its index.
 */
export const TagListSchema: z.ZodType<string[], string[]> = z
  .array(TagSchema)
  .superRefine((tags, context) => {
    for (const { index } of findRepeats(tags.map(foldName))) {
      context.addIssue({
        code: "custom",
        path: [index],
        message: `Tag ${tags[index]} is already in the list, ignoring case.`,
      });
    }
  })
  .describe("Tags, each nested with / and held once ignoring case; no whitespace or empty level.");
