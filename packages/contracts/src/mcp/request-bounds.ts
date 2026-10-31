// The text and address bounds every `mcp.*` request shares. A request's own schema builds its
// fields from these, so one limit holds for each command, name, value, address and search text.
import { z } from "zod";

import { wireFreeFormString } from "../free-form-string.js";

/**
 * The longest command, argument, name, value, address or search text an `mcp.*`
 * request carries.
 */
export const MCP_REQUEST_TEXT_MAX_LEN = 8192;

/**
 * A request text of at most {@link MCP_REQUEST_TEXT_MAX_LEN} code points, named `fieldLabel` in a
 * refusal.
 */
export const mcpRequestText = (fieldLabel: string): z.ZodString =>
  wireFreeFormString(MCP_REQUEST_TEXT_MAX_LEN, fieldLabel);

/** An `http:` or `https:` address; `http:` is legal because a server may listen on loopback. */
export const mcpHttpAddressSchema: z.ZodURL = z.url({ protocol: /^https?$/u });

/** An `http:` or `https:` address, taken as typed, a user name or password in it included. */
export const mcpServerAddressSchema: z.ZodURL = mcpHttpAddressSchema.max(MCP_REQUEST_TEXT_MAX_LEN);
