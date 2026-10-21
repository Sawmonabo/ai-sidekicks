//! The byte budget every paged reply shares. A row count alone is no bound, since one entry can
//! run to tens of kilobytes, so each page is measured in bytes against a budget well inside the
//! message cap.

use serde::Serialize;

use crate::jsonrpc::byte_length::fits_budget;
use crate::typescript::{TypeScriptModule, ts_constants};

ts_constants! {
    /// The byte ceiling on a reply's one large member, measured as its JSON's UTF-8 length: a
    /// page's entries, hits, sessions or groups, or a read's stored body or files. It is a
    /// 1,000,000-byte reply less 8,192 bytes for the message, the echoed id and a continuation
    /// cursor.
    pub const PAGE_MAX_BYTES: usize = 991_808;
}

/// How many leading entries of `candidates`, at most `max_count`, fit `budget_bytes` once written
/// as one JSON array, each taking the bytes `entry_bytes` gives it (for an entry that is its own
/// JSON, [`json_utf8_byte_length`](crate::jsonrpc::byte_length::json_utf8_byte_length)), so a page
/// built from the count passes its cap. A non-empty list yields at least one, since none would
/// stall the cursor; a lone entry over the budget is then refused by the reply's cap. Fails only
/// where `entry_bytes` fails.
pub fn count_entries_fitting_one_frame<T>(
    candidates: &[T],
    max_count: usize,
    budget_bytes: usize,
    mut entry_bytes: impl FnMut(&T) -> serde_json::Result<usize>,
) -> serde_json::Result<usize> {
    // The two brackets are charged up front; every entry past the first also charges a comma.
    let mut used_bytes = 2;
    let mut fitted_count = 0;
    for candidate in candidates.iter().take(max_count) {
        let entry_bytes = entry_bytes(candidate)?;
        let separator_bytes = usize::from(fitted_count > 0);
        if used_bytes + separator_bytes + entry_bytes > budget_bytes {
            // A first entry alone over the budget rides alone rather than leave an empty page
            // beside an unconsumed cursor.
            return Ok(fitted_count.max(1));
        }
        used_bytes += separator_bytes + entry_bytes;
        fitted_count += 1;
    }
    Ok(fitted_count)
}

/// A garde check that a reply member fits [`PAGE_MAX_BYTES`], measured as the count above
/// measures it, so a page the count built always passes.
pub fn fits_one_page<T: Serialize>(member: &T, (): &()) -> garde::Result {
    fits_budget(member, PAGE_MAX_BYTES)
}

/// The TypeScript module of the page budget.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "jsonrpc/page",
    doc: "The byte budget every paged reply shares: each page is measured in bytes against a \
          budget well inside the message cap.",
    definitions: &[],
    constants: TS_CONSTANTS,
    method_tables: &[],
};

#[cfg(test)]
mod tests {
    use serde::Deserialize;
    use serde_json::Value;

    use super::count_entries_fitting_one_frame;
    use crate::jsonrpc::byte_length::json_utf8_byte_length;

    /// One case of the table the TypeScript copy also reads.
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct PageFittingCase {
        note: String,
        candidates: Vec<Value>,
        max_count: usize,
        budget_bytes: usize,
        fitted: usize,
    }

    #[test]
    fn a_page_takes_the_entries_its_budget_and_row_limit_allow() {
        let cases: Vec<PageFittingCase> = serde_json::from_str(include_str!(
            "../../tests/fixtures/jsonrpc/page-fitting.json"
        ))
        .expect("the case table reads");
        for case in cases {
            assert_eq!(
                count_entries_fitting_one_frame(
                    &case.candidates,
                    case.max_count,
                    case.budget_bytes,
                    json_utf8_byte_length
                )
                .expect("a value serializes"),
                case.fitted,
                "{}",
                case.note
            );
        }
    }
}
