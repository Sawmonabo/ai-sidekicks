// The numeric error codes of a JSON-RPC response. They build no schema, so code that only raises
// or reads an error loads no schema library.

/**
 * The five numeric error codes JSON-RPC 2.0 reserves and the only ones the daemon emits;
 * domain errors ride in `error.data.type`. Shared so the daemon's mapping and the SDK's decoding
 * use one declaration.
 */
export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

/** The union of the numeric values in {@link JsonRpcErrorCode}. */
export type JsonRpcErrorCodeValue = (typeof JsonRpcErrorCode)[keyof typeof JsonRpcErrorCode];
