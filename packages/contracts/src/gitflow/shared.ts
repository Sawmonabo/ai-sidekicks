// Scalars the git-flow modules share. Not exported from the package root: each is a building
// block of a public schema, not a contract of its own.
import { z } from "zod";

import { wireUncappedFreeFormString } from "../session.js";

/** A commit's short id, git's own abbreviation, which is as long as the repository needs. */
export const GitShortObjectIdSchema: z.ZodType<string, string> = z
  .string()
  .regex(/^[0-9a-f]{4,64}$/u, "Expected an abbreviated hex git object id");

/** A branch or other ref name; git's own rule judges it, so the wire sets no length. */
export const GitRefNameSchema: z.ZodType<string, string> =
  wireUncappedFreeFormString("git ref name");

/** An address on the hosting service, opened in the system browser. */
export const HostingAddressSchema: z.ZodType<string, string> = z.url({ protocol: /^https?$/u });

/** A change request's number on its host: `#482` on GitHub, `!482` on GitLab. */
export const ChangeRequestNumberSchema: z.ZodType<number, number> = z.number().int().positive();

/** An id the hosting service minted (a thread, a comment, a check). Opaque to every client. */
export const HostHandleSchema: z.ZodType<string, string> = z.string().min(1);
