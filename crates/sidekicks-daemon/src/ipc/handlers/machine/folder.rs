//! `machine.folder.list`: one folder's folders for another device's folder chooser, each marked
//! when it is a repository's own top level.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::repo::folders::MachineFolderListRequest;
use sidekicks_contracts::repo::methods::MachineFolderList;
use sidekicks_ipc::registry::{
    HandlerContext, HandlerError, MethodRegistryBuilder, RegistrationError,
};
use sidekicks_workspace::folder::list::{FolderListError, FolderListService};

/// Registers `machine.folder.list` on `folders`. The top level, a WSL place and a folder that
/// cannot be read are refused with their codes; a failed repository check is a fault. Fails the
/// start when the method is already registered.
pub(crate) fn register_machine_folders(
    registry: &mut MethodRegistryBuilder,
    folders: Arc<FolderListService>,
) -> Result<(), RegistrationError> {
    registry.register::<MachineFolderList, _>(
        move |request: MachineFolderListRequest, _context: HandlerContext| {
            let folders = Arc::clone(&folders);
            async move { folders.list(request).await.map_err(handler_error_of) }.boxed()
        },
    )
}

// A refusal answers with its code; a path the wire cannot carry or a failed repository check is a
// fault in the daemon.
fn handler_error_of(error: FolderListError) -> HandlerError {
    match error {
        FolderListError::Refused(refusal) => HandlerError::Refused(refusal.into()),
        fault @ (FolderListError::PathNotSendable(_) | FolderListError::RepositoryCheck(_)) => {
            HandlerError::Internal(Box::new(fault))
        }
    }
}
