//! The two session searches: `session.search` across every session's index rows, a damaged
//! session's log hits stopping at its damaged point, where every read of it stops, and
//! `session.file.search`, the `@` search in one session's working folder. Both are reads.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::session::methods::{
    SessionFileSearch, SessionFileSearchRequest, SessionSearch, SessionSearchRequest,
};
use sidekicks_ipc::registry::{HandlerContext, MethodRegistryBuilder, RegistrationError};
use sidekicks_session::search::files::service::FileSearchService;
use sidekicks_session::search::index::live::LiveIndex;
use sidekicks_store::events::session::read::DamagedFromSequenceReader;

/// What the two session searches read through.
pub(crate) struct SessionSearchMethods {
    /// The search index `session.search` pages.
    pub(crate) index: Arc<LiveIndex>,
    /// The `@` search over each session's working folder.
    pub(crate) files: Arc<FileSearchService>,
    /// Where a damaged session's reads stop, and so its log hits.
    pub(crate) read_damaged_from_sequence: Arc<DamagedFromSequenceReader>,
}

/// Registers `session.search`, refusing a cursor that continues no held search
/// `session.search.cursorUnresolvable`, and `session.file.search`, refusing an unknown session
/// `session.notFound` and a working folder not in place `session.workingFolder.missing`. Fails the
/// start when either is already registered.
pub(crate) fn register_session_search(
    registry: &mut MethodRegistryBuilder,
    methods: SessionSearchMethods,
) -> Result<(), RegistrationError> {
    let SessionSearchMethods {
        index,
        files,
        read_damaged_from_sequence,
    } = methods;
    registry.register::<SessionSearch, _>(
        move |request: SessionSearchRequest, _context: HandlerContext| {
            let index = Arc::clone(&index);
            let read_damaged_from_sequence = Arc::clone(&read_damaged_from_sequence);
            async move {
                Ok(index
                    .search_sessions(request, read_damaged_from_sequence)
                    .await?)
            }
            .boxed()
        },
    )?;
    registry.register::<SessionFileSearch, _>(
        move |request: SessionFileSearchRequest, _context: HandlerContext| {
            let files = Arc::clone(&files);
            async move { Ok(files.search(request).await?) }.boxed()
        },
    )
}
