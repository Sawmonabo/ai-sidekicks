//! Turns the text a person typed into the words the search index looks for and the tags it names.
//! Every word goes to the index as typed, which tokenizes and folds it into a phrase, so a typed
//! `-`, `*`, `:`, `AND`, `OR` or `NOT` stays text; the last word matches as a prefix while it is
//! still being typed.

use std::sync::LazyLock;

use regex::Regex;
use sidekicks_contracts::name_fold::fold_name;
use sidekicks_contracts::wire::text::is_ecmascript_whitespace;
use sidekicks_search::index::SearchQuery;

/// What a search box query asks for: words for the index, and tags a session carries.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ParsedSearchQuery {
    /// The words the index looks for, `None` when the query names none.
    pub(crate) search_query: Option<SearchQuery>,
    /// Each `tag:<tag>` term's case fold; a session must carry each tag or one nested under it.
    pub(crate) tag_folds: Vec<String>,
}

const TAG_TERM_PREFIX: &str = "tag:";

// A word with no letter or digit holds no token, so it looks for nothing.
static TOKEN_CHARACTER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[\p{L}\p{N}]").expect("the token character class is a valid regular expression")
});

/// Parses a `Search all sessions` query: `tag:<tag>` terms are tags, every other term a word.
pub(crate) fn parse_session_search_query(query: &str) -> ParsedSearchQuery {
    let terms = split_terms(query);
    let mut words = Vec::new();
    let mut tag_folds = Vec::new();
    for &term in &terms {
        let is_tag_term = term
            .get(..TAG_TERM_PREFIX.len())
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case(TAG_TERM_PREFIX));
        if is_tag_term {
            let tag = term[TAG_TERM_PREFIX.len()..].trim_end_matches('/');
            if !tag.is_empty() {
                tag_folds.push(fold_name(tag));
            }
        } else {
            words.push(term);
        }
    }
    ParsedSearchQuery {
        search_query: search_query_of_words(&words, &terms, query),
        tag_folds,
    }
}

/// The words of a find box query inside one session, where every term is a word.
pub(crate) fn parse_find_query(query: &str) -> Option<SearchQuery> {
    let terms = split_terms(query);
    search_query_of_words(&terms, &terms, query)
}

fn split_terms(query: &str) -> Vec<&str> {
    query
        .split(is_ecmascript_whitespace)
        .filter(|term| !term.is_empty())
        .collect()
}

// The query's words that hold a token, from `word_terms` among every one of its `terms`.
fn search_query_of_words(word_terms: &[&str], terms: &[&str], query: &str) -> Option<SearchQuery> {
    let words: Vec<String> = word_terms
        .iter()
        .filter(|term| TOKEN_CHARACTER.is_match(term))
        .map(|&term| term.to_owned())
        .collect();
    // A query that ends in a space has finished its last word, and so has one whose last term is a
    // tag or holds no token.
    let last_word_is_prefix = !query.ends_with(is_ecmascript_whitespace)
        && words.last().map(String::as_str) == terms.last().copied();
    (!words.is_empty()).then_some(SearchQuery {
        words,
        last_word_is_prefix,
    })
}
