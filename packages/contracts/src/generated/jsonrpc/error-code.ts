// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The numeric codes of a JSON-RPC error. They build no check, so code that only raises or reads an error loads no schema library.

/**
 * The numeric codes of a JSON-RPC error, by name; a domain refusal rides in
 * `error.data.type`.
 */
export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  RequestCanceled: -32800,
  DomainRefusal: -31000,
} as const;

/**
 * A JSON-RPC error's numeric code.
 */
export type JsonRpcErrorCodeValue = -32700 | -32600 | -32601 | -32602 | -32603 | -32800 | -31000;
