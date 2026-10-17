//! The `transcript.*` methods. All are queries: the transcript is the daemon's own projection of
//! the session event log.

use crate::method::methods;
use crate::transcript::content::{
    TranscriptBodyReadRequest, TranscriptBodyReadResponse, TranscriptPatchListRequest,
    TranscriptPatchListResponse,
};
use crate::transcript::operations::{
    ChildRunExpandRequest, ChildRunExpandResponse, ReasoningSurfaceReadRequest,
    ReasoningSurfaceReadResponse, TranscriptReadRequest, TranscriptReadResponse,
};
use crate::transcript::search::{TranscriptSearchRequest, TranscriptSearchResponse};
use crate::typescript::TypeScriptModule;

methods! {
    /// The `transcript.*` methods' wire contract: name, procedure type and types.
    pub const TRANSCRIPT_METHOD_DESCRIPTORS = [
        /// Reads one bounded window of a session's transcript, or the window around one row.
        TranscriptRead = query "transcript.read" {
            mutating: false,
            params: TranscriptReadRequest,
            result: TranscriptReadResponse,
            refusals: [SessionNotFound, SessionEventCursorUnresolvable, TranscriptRowNotFound],
        },
        /// Reads a run's reasoning, page by page.
        TranscriptReasoningRead = query "transcript.reasoning.read" {
            mutating: false,
            params: ReasoningSurfaceReadRequest,
            result: ReasoningSurfaceReadResponse,
            refusals: [SessionEventCursorUnresolvable],
        },
        /// Expands one summarized child-run row into its own rows.
        TranscriptChildRunExpand = query "transcript.childRun.expand" {
            mutating: false,
            params: ChildRunExpandRequest,
            result: ChildRunExpandResponse,
            refusals: [SessionEventCursorUnresolvable],
        },
        /// Reads a row's large body or full output.
        TranscriptBodyRead = query "transcript.body.read" {
            mutating: false,
            params: TranscriptBodyReadRequest,
            result: TranscriptBodyReadResponse,
            refusals: [SessionNotFound, TranscriptRowNotFound],
        },
        /// Reads every file patch a tool call left out.
        TranscriptPatchList = query "transcript.patch.list" {
            mutating: false,
            params: TranscriptPatchListRequest,
            result: TranscriptPatchListResponse,
            refusals: [SessionNotFound],
        },
        /// Searches every row one session holds.
        TranscriptSearch = query "transcript.search" {
            mutating: false,
            params: TranscriptSearchRequest,
            result: TranscriptSearchResponse,
            refusals: [SessionNotFound, SessionEventCursorUnresolvable],
        },
    ];
}

/// The module's TypeScript face: the method table.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "transcript/methods",
    doc: "The `transcript.*` methods, each bound to its request and response.",
    definitions: &[],
    constants: &[],
    method_tables: &[&TRANSCRIPT_METHOD_DESCRIPTORS],
};
