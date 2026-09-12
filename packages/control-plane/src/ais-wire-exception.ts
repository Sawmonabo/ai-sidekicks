// Cross-domain base class for every control-plane exception the tRPC
// `errorFormatter` projects onto the wire `shape.data.aisError` envelope.
//
// One `instanceof AisWireException` in the formatter (`sessions/trpc.ts`)
// matches the WHOLE family — today the runtime-node-domain subclasses
// (`RuntimeNodeAttachConflictException` / `RuntimeNodeAttachRevokedException` /
// `RuntimeNodeCapabilityUpdateConflictException` /
// `VersionFloorExceededException` in `runtime-nodes/errors.ts`). Before this
// base existed the formatter carried one `instanceof` branch per concrete
// class; collapsing them onto a single match-type is what completes the
// uniform projection.
//
// Two-axis contract every subclass satisfies:
//   * `code` — the stable wire-code literal (a `@ai-sidekicks/contracts`
//     `*_CODE` constant), `abstract` here so each subclass pins its own
//     literal type. The formatter lifts it onto `aisError.code`.
//   * `details` — OPTIONAL on the base, mirroring the canonical wire
//     `ErrorResponse` envelope. A detail-carrying subclass NARROWS it to a
//     required, concrete interface; a code+message-only subclass (every
//     subclass today) inherits the base default, so its `details ===
//     undefined` and the formatter emits a `{code, message}` envelope with no
//     `details` key.
//
// `details` is typed `AisWireErrorDetails` (a UNION of concrete detail
// interfaces), not `Record<string, unknown>`: a subclass overriding it with a
// concrete interface must be ASSIGNABLE to the base's declared type, and a
// concrete interface is NOT
// assignable to `Record<string, unknown>` under `exactOptionalPropertyTypes`
// without a cast (the index-signature trap). A union of the exact member
// shapes sidesteps that — each override widens to one union member cleanly.
//
// NOT barrel-exported from `index.ts`: this is internal transport
// infrastructure. No external consumer constructs an `AisWireException`
// (subclasses are thrown by the services; the formatter only matches the
// base), so it stays off the package's public surface.
//
// See `sessions/trpc.ts` (the single-`instanceof` formatter this base
// enables) and `runtime-nodes/errors.ts` (the subclasses).

export abstract class AisWireException extends Error {
  abstract readonly code: string;
}
