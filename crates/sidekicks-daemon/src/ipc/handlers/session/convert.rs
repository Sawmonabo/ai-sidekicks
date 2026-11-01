//! `session.convert`, which turns a chat into a project in place, in the repository at the typed
//! path, and `session.conversion.skippedFile.list`, which reads back, page by page, the files a
//! conversion did not copy.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::session::convert::{
    SessionConversionSkippedFileListRequest, SessionConvertRequest,
};
use sidekicks_contracts::session::directory::SessionConvert;
use sidekicks_contracts::session::methods::SessionConversionSkippedFileList;
use sidekicks_ipc::registry::{HandlerContext, MethodRegistryBuilder, RegistrationError};
use sidekicks_session::convert::SessionConversion;

/// Registers `session.convert` and `session.conversion.skippedFile.list` over `conversion`, which
/// refuses as its doc names. Fails the start when a method is already registered.
pub(crate) fn register_session_convert(
    registry: &mut MethodRegistryBuilder,
    conversion: Arc<SessionConversion>,
) -> Result<(), RegistrationError> {
    let converting = Arc::clone(&conversion);
    registry.register::<SessionConvert, _>(
        move |request: SessionConvertRequest, _context: HandlerContext| {
            let conversion = Arc::clone(&converting);
            async move { Ok(conversion.convert(&request).await?) }.boxed()
        },
    )?;
    registry.register::<SessionConversionSkippedFileList, _>(
        move |request: SessionConversionSkippedFileListRequest, _context: HandlerContext| {
            let conversion = Arc::clone(&conversion);
            async move { Ok(conversion.list_skipped_files(&request).await?) }.boxed()
        },
    )
}
