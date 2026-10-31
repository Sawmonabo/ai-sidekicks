//! The refusal categories: what a client can do about a refusal, sent beside its code.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use strum::VariantArray;

/// What a client can do about a refusal, sent as `data.category` beside its code so a client that
/// meets a code newer than itself still acts on it: one of the categories this build knows, or the
/// text of one a newer build sends, so a newer daemon's refusal is still read as a refusal.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum RefusalCategory {
    /// A category this build knows.
    Known(KnownRefusalCategory),
    /// A category a newer build sends and this one does not know, its wire text kept; no refusal
    /// this build makes carries one, since each code's category is a known one.
    Unknown(String),
}

impl RefusalCategory {
    /// The category's wire text.
    pub fn as_str(&self) -> &str {
        match self {
            Self::Known(known) => known.as_str(),
            Self::Unknown(text) => text.as_str(),
        }
    }
}

/// The categories this build knows: the canonical gRPC status codes.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, VariantArray,
)]
#[serde(rename_all = "camelCase")]
pub enum KnownRefusalCategory {
    /// Fix what it sent.
    InvalidArgument,
    /// Stop naming the thing, or refresh its list.
    NotFound,
    /// Pick another name or use the existing thing.
    AlreadyExists,
    /// Change the state first (finish, stop, sign in), then send again.
    FailedPrecondition,
    /// Read again and retry: it lost a race or acted on an old version.
    Aborted,
    /// Get a valid credential.
    Unauthenticated,
    /// Nothing: this caller may not do this.
    PermissionDenied,
    /// Wait, or send less.
    ResourceExhausted,
    /// Retry the same call later.
    Unavailable,
    /// Nothing here: this provider, account, model or build does not offer it.
    Unimplemented,
    /// Retry; a deadline passed.
    DeadlineExceeded,
    /// Nothing: the caller canceled.
    Canceled,
    /// Report it: the service failed.
    Internal,
}

impl KnownRefusalCategory {
    /// The category's wire text, as its serde form writes it.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidArgument => "invalidArgument",
            Self::NotFound => "notFound",
            Self::AlreadyExists => "alreadyExists",
            Self::FailedPrecondition => "failedPrecondition",
            Self::Aborted => "aborted",
            Self::Unauthenticated => "unauthenticated",
            Self::PermissionDenied => "permissionDenied",
            Self::ResourceExhausted => "resourceExhausted",
            Self::Unavailable => "unavailable",
            Self::Unimplemented => "unimplemented",
            Self::DeadlineExceeded => "deadlineExceeded",
            Self::Canceled => "canceled",
            Self::Internal => "internal",
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use strum::VariantArray as _;

    use super::{KnownRefusalCategory, RefusalCategory};

    // The untagged form takes its first arm that reads, so a known category's text must read as
    // `Known`, and each one's `as_str` must be the text serde writes.
    #[test]
    fn every_known_category_reads_from_its_text_as_known_and_writes_as_its_text() {
        for &known in KnownRefusalCategory::VARIANTS {
            let read: RefusalCategory =
                serde_json::from_value(json!(known.as_str())).expect("a category's text reads");
            assert_eq!(read, RefusalCategory::Known(known));
            let written = serde_json::to_value(known).expect("a category writes");
            assert_eq!(written, json!(known.as_str()));
        }
    }
}
