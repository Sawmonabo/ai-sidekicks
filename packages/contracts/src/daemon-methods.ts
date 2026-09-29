// The daemon's method and event map, as every client of the daemon names it (stubs).
//
// The `__daemon_*_stub__` brands make every consumer acknowledge it holds a stub. When the
// real discriminated unions land the brands go and existing call sites keep typechecking,
// because a brand is only a structural marker.

/**
 * Method name brand (stub), replaced by the `DaemonMethod` string-literal union once it
 * exists.
 */
export type DaemonMethod = string & { readonly __daemon_method_stub__: never };

/**
 * Method params (stub), replaced by the method-to-params map once it exists. `unknown`
 * forces a caller to narrow before use.
 */
export type DaemonParams<M extends DaemonMethod> = M extends DaemonMethod ? unknown : never;

/** Method result (stub). */
export type DaemonResult<M extends DaemonMethod> = M extends DaemonMethod ? unknown : never;

/** Event name brand (stub), replaced by the `DaemonEvent` string-literal union. */
export type DaemonEvent = string & { readonly __daemon_event_stub__: never };

/** Event payload (stub). */
export type DaemonEventPayload<E extends DaemonEvent> = E extends DaemonEvent ? unknown : never;
