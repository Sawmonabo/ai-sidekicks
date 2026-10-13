//! A held review note: a note the person leaves on a line of Review's diff, held by the daemon and
//! scoped to the session, so a half-written review reaches the person's other devices. A note is
//! held until it is composed into the draft as a steer, posted with a review to the hosting
//! service, or discarded. A note whose line no longer exists in the diff is stranded: it can still
//! be read, edited and deleted, and is left out of a posted review.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::free_form_string::FILE_PATH_MAX_LEN;
use crate::internal::branded::branded_uuid_id;
use crate::jsonrpc::streaming::SubscribeAckResponse;
use crate::method::methods;
use crate::repo::git_reads::GitObjectId;
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::instant::WireInstant;
use crate::wire::integer::SafeInt;
use crate::wire::list::BoundedVec;
use crate::wire::text::{BoundedText, NonEmptyText};

branded_uuid_id! {
    /// The id of one held note, minted by the client, so adding the same note twice makes one note.
    ReviewNoteId
}

/// A path in the diff a note is left on.
pub type ReviewNotePath = BoundedText<1, FILE_PATH_MAX_LEN>;

/// The scopes a note can be left in: the uncommitted changes, the branch, or a pull request.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ReviewNoteScope {
    /// The uncommitted changes.
    Changes,
    /// The branch.
    Branch,
    /// A pull request.
    ChangeRequest,
}

/// Which side of the diff the note's line is on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ReviewNoteSide {
    /// An added line.
    Added,
    /// A removed line.
    Removed,
}

/// Declares one form of the comparison a note was left in: the members both forms share, then the
/// form's own end.
macro_rules! review_note_comparison {
    ($(#[doc = $doc:literal])+ pub struct $name:ident { $($own:tt)* }) => {
        $(#[doc = $doc])+
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        #[schemars(inline)]
        pub struct $name {
            /// The scope.
            pub scope: ReviewNoteScope,
            /// The comparison's base.
            pub base: NonEmptyText,
            $($own)*
            /// The pull request, in that scope.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "SafeInt<1>")]
            pub request_number: Option<SafeInt<1>>,
        }
    };
}

review_note_comparison! {
    /// A comparison on committed lines, naming the head commit.
    pub struct CommittedReviewNoteComparison {
        /// The head commit.
        pub head_commit_id: GitObjectId,
    }
}

review_note_comparison! {
    /// A comparison on uncommitted lines, naming the working tree's blob; such a note is left out
    /// of a posted review.
    pub struct WorkingTreeReviewNoteComparison {
        /// The working tree's blob.
        pub working_tree_blob_id: GitObjectId,
    }
}

/// The comparison a note was left in, so pressing the note takes the reader back to it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum ReviewNoteComparison {
    /// On committed lines.
    Committed(CommittedReviewNoteComparison),
    /// On uncommitted lines.
    WorkingTree(WorkingTreeReviewNoteComparison),
}

/// Declares a type holding a note's place: the comparison, the file (and its earlier path when it
/// was renamed), the side, the line, and for a note on several lines the first of them, which comes
/// at or before the last; then the type's own members.
macro_rules! review_note_located {
    ($(#[doc = $doc:literal])+ pub struct $name:ident { $($own:tt)* }) => {
        $(#[doc = $doc])+
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        #[garde(allow_unvalidated)]
        #[garde(custom(|located: &$name, (): &()| starts_at_or_before_its_line(
            located.start_line,
            located.line,
        )))]
        pub struct $name {
            /// The comparison it was left in.
            pub comparison: ReviewNoteComparison,
            /// The file.
            pub path: ReviewNotePath,
            /// The file's earlier path, when it was renamed.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "ReviewNotePath")]
            pub old_path: Option<ReviewNotePath>,
            /// The line's side.
            pub side: ReviewNoteSide,
            /// The line, or the last of several.
            pub line: SafeInt<1>,
            /// The first of several lines, at or before `line`.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "SafeInt<1>", extend("maximum" = { "$data": "1/line" }))]
            pub start_line: Option<SafeInt<1>>,
            $($own)*
        }
    };
}

fn starts_at_or_before_its_line(start_line: Option<SafeInt<1>>, line: SafeInt<1>) -> garde::Result {
    match start_line {
        Some(start_line) if start_line > line => Err(garde::Error::new(
            "a note's first line comes at or before its last line",
        )),
        Some(_) | None => Ok(()),
    }
}

review_note_located! {
    /// One held note as the daemon holds it: where it sits, a one-line quote of its line, the
    /// person's words, whether its line still exists in the diff, and when it was made and last
    /// edited.
    pub struct ReviewNote {
        /// The note.
        pub note_id: ReviewNoteId,
        /// A one-line quote of its line.
        pub quote: String,
        /// The person's words.
        pub body: NonEmptyText,
        /// Whether its line is gone from the diff.
        pub stranded: bool,
        /// When it was made.
        #[garde(dive)]
        pub created_at: WireInstant,
        /// When it was last edited.
        #[garde(dive)]
        pub updated_at: WireInstant,
    }
}

review_note_located! {
    /// `session.reviewNoteAdd`: holds a new note.
    pub struct ReviewNoteAddRequest {
        /// The session.
        pub session_id: SessionId,
        /// The note.
        pub note_id: ReviewNoteId,
        /// The person's words.
        pub body: NonEmptyText,
    }
}

/// The note as the daemon holds it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewNoteResponse {
    /// The note.
    #[garde(dive)]
    pub note: ReviewNote,
}

/// `session.reviewNoteUpdate`: replaces a held note's words.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewNoteUpdateRequest {
    /// The session.
    pub session_id: SessionId,
    /// The note.
    pub note_id: ReviewNoteId,
    /// The new words.
    pub body: NonEmptyText,
}

/// `session.reviewNoteRemove`: discards held notes in one act; the notes chip's `×` discards every
/// note behind one question, and a steer clears every note it carried.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewNoteRemoveRequest {
    /// The session.
    pub session_id: SessionId,
    /// The notes.
    pub note_ids: BoundedVec<ReviewNoteId, 1, { usize::MAX }>,
}

/// The notes a remove discarded; an id the session did not hold is left out.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewNoteRemoveResponse {
    /// The notes discarded.
    pub removed_note_ids: Vec<ReviewNoteId>,
}

/// The session's held notes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewNoteSet {
    /// The notes.
    #[garde(dive)]
    pub notes: Vec<ReviewNote>,
}

/// `session.reviewNoteList`: follows a session's held notes, the whole set now and on each change.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewNoteListRequest {
    /// The session.
    pub session_id: SessionId,
}

methods! {
    /// The held-note methods.
    pub const REVIEW_NOTE_METHOD_DESCRIPTORS = [
        /// Holds a new note; adding the same note id again makes one note.
        SessionReviewNoteAdd = mutation "session.reviewNoteAdd" {
            mutating: true,
            params: ReviewNoteAddRequest,
            result: ReviewNoteResponse,
            refusals: [SessionNotFound, SessionReviewNoteNotFound],
        },
        /// Replaces a held note's words.
        SessionReviewNoteUpdate = mutation "session.reviewNoteUpdate" {
            mutating: true,
            params: ReviewNoteUpdateRequest,
            result: ReviewNoteResponse,
            refusals: [SessionNotFound, SessionReviewNoteNotFound],
        },
        /// Discards held notes.
        SessionReviewNoteRemove = mutation "session.reviewNoteRemove" {
            mutating: true,
            params: ReviewNoteRemoveRequest,
            result: ReviewNoteRemoveResponse,
            refusals: [SessionNotFound],
        },
        /// Follows the session's held notes.
        SessionReviewNoteList = subscription "session.reviewNoteList" {
            mutating: false,
            params: ReviewNoteListRequest,
            result: SubscribeAckResponse,
            emission: ReviewNoteSet,
            refusals: [SessionNotFound],
        },
    ];
}

/// The TypeScript module of held review notes.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "review-note",
    doc: "A held review note: a note the person leaves on a line of Review's diff, held by the \
          daemon and scoped to the session.",
    definitions: &[
        Definition::read::<ReviewNoteId>().checked(),
        Definition::read::<ReviewNoteScope>(),
        Definition::read::<ReviewNoteSide>(),
        Definition::read::<ReviewNoteComparison>(),
        Definition::read::<ReviewNote>(),
        Definition::read::<ReviewNoteAddRequest>().checked(),
        Definition::read::<ReviewNoteResponse>(),
        Definition::read::<ReviewNoteUpdateRequest>(),
        Definition::read::<ReviewNoteRemoveRequest>(),
        Definition::read::<ReviewNoteRemoveResponse>(),
        Definition::read::<ReviewNoteSet>().checked(),
        Definition::read::<ReviewNoteListRequest>(),
    ],
    constants: &[],
    method_tables: &[&REVIEW_NOTE_METHOD_DESCRIPTORS],
};
