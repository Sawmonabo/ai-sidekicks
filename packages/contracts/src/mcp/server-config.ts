// An MCP server's declaration: what a person submits, environment and header values write-only,
// and its redacted read-back, which carries their names where the wire would carry values, so a
// client rendering every read-back still cannot render a value or a token. The text and address
// bounds every `mcp.*` request shares sit here too.
import { z } from "zod";

import { wireFreeFormString } from "../free-form-string.js";

/**
 * The redacted read-back of a binding's declaration, by transport. The env map, header map and
 * URL query arrive as keys only, since their values are credentials; the daemon strips the URL's
 * query and any user name or password from it, and a client shows it verbatim.
 */
export type McpServerConfigView =
  | {
      transport: "stdio";
      command: string;
      args?: string[] | undefined;
      envVarNames?: string[] | undefined;
      enabled?: boolean | undefined;
      required?: boolean | undefined;
      startupTimeoutSec?: number | undefined;
      toolTimeoutSec?: number | undefined;
    }
  | {
      transport: "http" | "sse";
      url: string;
      urlQueryParamNames?: string[] | undefined;
      headerNames?: string[] | undefined;
      bearerTokenEnvVar?: string | undefined;
      envHttpHeaders?: Record<string, string> | undefined;
      oauthScopes?: string[] | undefined;
      oauthResource?: string | undefined;
      enabled?: boolean | undefined;
      required?: boolean | undefined;
      startupTimeoutSec?: number | undefined;
      toolTimeoutSec?: number | undefined;
    };

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

const mcpTimeoutSecondsSchema = z.number().positive();

/**
 * A server's declaration as the person submits it, by transport. Environment and header values are
 * write-only, handed to the provider's write path and never served back; unset members keep the
 * provider's values.
 */
export type McpServerConfigInput =
  | {
      transport: "stdio";
      command: string;
      args?: string[] | undefined;
      env?: Record<string, string> | undefined;
      enabled?: boolean | undefined;
      required?: boolean | undefined;
      startupTimeoutSec?: number | undefined;
      toolTimeoutSec?: number | undefined;
    }
  | {
      transport: "http" | "sse";
      url: string;
      headers?: Record<string, string> | undefined;
      bearerTokenEnvVar?: string | undefined;
      /** A header name mapped to the name of the environment variable holding its value. */
      envHttpHeaders?: Record<string, string> | undefined;
      oauthScopes?: string[] | undefined;
      oauthResource?: string | undefined;
      enabled?: boolean | undefined;
      required?: boolean | undefined;
      startupTimeoutSec?: number | undefined;
      toolTimeoutSec?: number | undefined;
    };

// The settings every transport carries, the same on a submitted declaration and its read-back.
const serverSettingsShape = {
  enabled: z.boolean().optional(),
  required: z.boolean().optional(),
  startupTimeoutSec: mcpTimeoutSecondsSchema.optional(),
  toolTimeoutSec: mcpTimeoutSecondsSchema.optional(),
};

const mcpTextMap = (fieldLabel: string) =>
  z.record(mcpRequestText(`${fieldLabel} name`), z.string().max(MCP_REQUEST_TEXT_MAX_LEN));

/** Parses an {@link McpServerConfigInput}; a member outside its transport's arm is refused. */
export const McpServerConfigInputSchema: z.ZodType<McpServerConfigInput, McpServerConfigInput> =
  z.discriminatedUnion("transport", [
    z
      .object({
        transport: z.literal("stdio"),
        command: mcpRequestText("McpServerConfigInput.command"),
        args: z.array(z.string().max(MCP_REQUEST_TEXT_MAX_LEN)).optional(),
        env: mcpTextMap("McpServerConfigInput.env").optional(),
        ...serverSettingsShape,
      })
      .strict(),
    z
      .object({
        transport: z.enum(["http", "sse"]),
        url: mcpServerAddressSchema,
        headers: mcpTextMap("McpServerConfigInput.headers").optional(),
        bearerTokenEnvVar: mcpRequestText("McpServerConfigInput.bearerTokenEnvVar").optional(),
        envHttpHeaders: mcpTextMap("McpServerConfigInput.envHttpHeaders").optional(),
        oauthScopes: z.array(mcpRequestText("McpServerConfigInput.oauthScopes")).optional(),
        oauthResource: mcpRequestText("McpServerConfigInput.oauthResource").optional(),
        ...serverSettingsShape,
      })
      .strict(),
  ]);

/** Parses an {@link McpServerConfigView}. */
export const McpServerConfigViewSchema: z.ZodType<McpServerConfigView> = z.discriminatedUnion(
  "transport",
  [
    z
      .object({
        transport: z.literal("stdio"),
        command: z.string(),
        args: z.array(z.string()).optional(),
        envVarNames: z.array(z.string()).optional(),
        ...serverSettingsShape,
      })
      .strict(),
    z
      .object({
        transport: z.enum(["http", "sse"]),
        url: z.string(),
        urlQueryParamNames: z.array(z.string()).optional(),
        headerNames: z.array(z.string()).optional(),
        bearerTokenEnvVar: z.string().optional(),
        envHttpHeaders: z.record(z.string(), z.string()).optional(),
        oauthScopes: z.array(z.string()).optional(),
        oauthResource: z.string().optional(),
        ...serverSettingsShape,
      })
      .strict(),
  ],
);
