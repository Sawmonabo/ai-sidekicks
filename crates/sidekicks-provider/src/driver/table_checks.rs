//! The provider table's checks, run as the crate compiles: every id matches the provider id
//! pattern, no two providers share one, and every name and resume command holds as declaration
//! text.

use sidekicks_contracts::provider::declaration::PROVIDER_DECLARATION_TEXT_MAX_LEN;
use sidekicks_contracts::provider::id::is_provider_id;

use crate::driver::{PROVIDERS, ProviderDescriptor, is_same_text};

const _: () = assert!(
    has_valid_ids(PROVIDERS),
    "a provider id breaks the id pattern"
);
const _: () = assert!(has_unique_ids(PROVIDERS), "two providers share an id");
const _: () = assert!(
    has_declarable_words(PROVIDERS),
    "a provider's name or resume command is not declaration text"
);

/// Whether every id in `table` matches the provider id pattern.
const fn has_valid_ids(table: &[&ProviderDescriptor]) -> bool {
    let mut i = 0;
    while i < table.len() {
        if !is_provider_id(table[i].id) {
            return false;
        }
        i += 1;
    }
    true
}

/// Whether every name and resume command in `table` holds as declaration text: no NUL, no more
/// bytes than its cap counts code points, and a visible ASCII character, so it is not blank.
const fn has_declarable_words(table: &[&ProviderDescriptor]) -> bool {
    let mut i = 0;
    while i < table.len() {
        if !is_declarable(table[i].name) || !is_declarable(table[i].terminal_resume_command) {
            return false;
        }
        i += 1;
    }
    true
}

// Whether `text` holds as declaration text, by the sufficient bounds `has_declarable_words` names.
// It must stay at least as strict as `FreeFormText::new`, since the daemon's `expect` on the
// declaration's text trusts this check.
const fn is_declarable(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes.len() > PROVIDER_DECLARATION_TEXT_MAX_LEN {
        return false;
    }
    let mut has_visible = false;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == 0 {
            return false;
        }
        has_visible |= bytes[i].is_ascii_graphic();
        i += 1;
    }
    has_visible
}

/// Whether no two entries of `table` share an id.
const fn has_unique_ids(table: &[&ProviderDescriptor]) -> bool {
    let mut i = 0;
    while i < table.len() {
        let mut j = i + 1;
        while j < table.len() {
            if is_same_text(table[i].id, table[j].id) {
                return false;
            }
            j += 1;
        }
        i += 1;
    }
    true
}
