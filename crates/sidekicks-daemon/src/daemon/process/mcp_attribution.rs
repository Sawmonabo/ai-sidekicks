//! The fills of the MCP attribution table outside the inventory's own reads: one once the
//! providers' first reads landed, and one after each project attach, re-attach or move, so a
//! session's reports resolve to their servers before any list.

use std::sync::Arc;

use sidekicks_mcp::inventory_service::McpInventoryService;
use sidekicks_workspace::repo::mount::attach_notice::ProjectAttachNotice;
use tokio_util::sync::CancellationToken;
use tokio_util::task::AbortOnDropHandle;

/// The task that fills the attribution table; dropping it ends the fill under way.
pub(crate) struct McpAttributionFills {
    _task: AbortOnDropHandle<()>,
}

impl McpAttributionFills {
    /// Fills the table through `inventory` now, then again after each raise of `attach_notice`,
    /// raises during a fill taking one fill after it, until `stop` is canceled.
    pub(crate) fn start(
        inventory: Arc<McpInventoryService>,
        attach_notice: Arc<ProjectAttachNotice>,
        stop: CancellationToken,
    ) -> Self {
        let task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    () = inventory.fill_attribution() => {}
                    () = stop.cancelled() => return,
                }
                tokio::select! {
                    () = attach_notice.wait() => {}
                    () = stop.cancelled() => return,
                }
            }
        });
        Self {
            _task: AbortOnDropHandle::new(task),
        }
    }
}
