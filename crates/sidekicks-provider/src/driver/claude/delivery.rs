//! What the Claude Code driver reads out of a process's deliveries and delivers to the run engine:
//! a call's ask, the rows of its message frames, the blocks it streams, a file change's patch, the
//! choices it holds a run on, the system frames, a turn's end, the requests it holds a run on, the
//! reviewer's blocks, and the stream that turns each frame into the run engine's deliveries in
//! order.

mod ask_action;
pub(super) mod dialogs;
pub(super) mod messages;
mod patches;
pub(super) mod requests;
pub(super) mod reviewer;
pub(super) mod run_readings;
pub(super) mod stream;
mod streamed_blocks;
pub(super) mod system;
mod turn_end;

use sidekicks_contracts::provider::account::record::ProviderAccountId;

use crate::driver::claude::DESCRIPTOR;
use crate::driver::delivery_dispatch::DeliveryOrigin;

/// Where a Claude Code delivery came from, as a refusal's diagnostic names it: the process on
/// `provider_account_id`'s account, `None` on the machine's own home, and the frame `raw_wire_type`
/// it was read from, `None` for the driver's own.
pub(crate) fn claude_delivery_origin(
    provider_account_id: Option<ProviderAccountId>,
    raw_wire_type: Option<&str>,
) -> DeliveryOrigin<'_> {
    DeliveryOrigin {
        provider: DESCRIPTOR.provider_id(),
        provider_account_id,
        raw_wire_type,
    }
}
