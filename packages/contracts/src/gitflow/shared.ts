// Scalars the git-flow contract's modules share: git's object ids and ref names,
// addresses on the hosting service, timestamps, change-request numbers, the host's
// own handles and counts. Private to `gitflow/`: the barrel does not re-export
// this module, because each value is a building block of a public schema, not a
// contract of its own.
import { z } from "zod";

import { wireFreeFormString } from "../session.js";
import { WORKTREE_GIT_REF_MAX_LEN } from "../worktree.js";

/** A git object id: a commit or a blob, as the full hex name git prints (SHA-1 or SHA-256). */
export const GitObjectIdSchema: z.ZodType<string, string> = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u, "Expected a full hex git object id");

/** A commit's short id, git's own abbreviation, which is as long as the repository needs. */
export const GitShortObjectIdSchema: z.ZodType<string, string> = z
  .string()
  .regex(/^[0-9a-f]{4,64}$/u, "Expected an abbreviated hex git object id");

/** A branch or other ref name. Shares the ref bound the worktree contract states. */
export const GitRefNameSchema: z.ZodType<string, string> = wireFreeFormString(
  WORKTREE_GIT_REF_MAX_LEN,
  "git ref name",
);

/** An address on the hosting service, opened in the system browser. */
export const HostingAddressSchema: z.ZodType<string, string> = z.url({ protocol: /^https?$/u });

/** A time with its offset, as RFC 3339 writes it. */
export const timestampSchema: z.ZodType<string, string> = z.iso.datetime({ offset: true });

/** A change request's number on its host: `#482` on GitHub, `!482` on GitLab. */
export const ChangeRequestNumberSchema: z.ZodType<number, number> = z.number().int().positive();

/** An id the hosting service minted (a thread, a comment, a check). Opaque to every client. */
export const HostHandleSchema: z.ZodType<string, string> = z.string().min(1);

/** A count of files, commits or bytes. */
export const countSchema: z.ZodType<number, number> = z.number().int().nonnegative();
