//! The method a provider's hook calls the daemon with.

use crate::wire::name::is_wire_name;

/// The method a connection a provider's hook opened calls, the one beside the ping it may call:
/// the daemon's own program, running in its `hook provider` mode, calls it with a Codex hook's
/// input and answers Codex with the reply.
pub const PROVIDER_HOOK_CALL_METHOD: &str = "provider.hook.call";

const _: () = assert!(
    is_wire_name(PROVIDER_HOOK_CALL_METHOD),
    "the hook method is not a wire name",
);
