//! A query's phrases: each typed word tokenized and folded as the index folds text.

use tantivy::Term;

use crate::SearchQuery;
use crate::schema::{IndexFields, PREFIX_FIELD_COUNT};
use crate::tokenizer::tokenize;

/// One typed word as the index matches it: its folded tokens, which must sit next to each other in
/// a row, the last one matched as a prefix while the word is still being typed.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Phrase {
    pub parts: Vec<String>,
    pub ends_in_prefix: bool,
}

/// The query's phrases in typed order; a word with no letter or digit in it is no phrase.
pub fn query_phrases(query: &SearchQuery) -> Vec<Phrase> {
    let last = query.words.len().saturating_sub(1);
    query
        .words
        .iter()
        .enumerate()
        .filter_map(|(index, word)| {
            let parts: Vec<String> = tokenize(word).into_iter().map(|token| token.folded).collect();
            let ends_in_prefix = query.last_word_is_prefix && index == last;
            (!parts.is_empty()).then_some(Phrase { parts, ends_in_prefix })
        })
        .collect()
}

impl Phrase {
    /// Whether part `index` matches as a prefix.
    pub fn is_prefix_part(&self, index: usize) -> bool {
        self.ends_in_prefix && index + 1 == self.parts.len()
    }

    /// Whether `token` matches part `index`.
    pub fn part_matches(&self, index: usize, token: &str) -> bool {
        if self.is_prefix_part(index) {
            token.starts_with(&self.parts[index])
        } else {
            token == self.parts[index]
        }
    }

    /// The one term that holds exactly this phrase's rows and counts, when one does: a whole word's
    /// text term, or a prefix field's term for a prefix of up to four characters.
    pub fn single_term(&self, fields: &IndexFields) -> Option<Term> {
        let [part] = self.parts.as_slice() else { return None };
        if !self.ends_in_prefix {
            return Some(Term::from_field_text(fields.text, part));
        }
        let length = part.chars().count();
        (length <= PREFIX_FIELD_COUNT)
            .then(|| Term::from_field_text(fields.prefixes[length - 1], part))
    }

    /// The whole-word text terms of a several-token phrase: each one holds every row the phrase
    /// matches, at least as many times.
    pub fn whole_part_terms(&self, fields: &IndexFields) -> Vec<Term> {
        (0..self.parts.len())
            .filter(|index| !self.is_prefix_part(*index))
            .map(|index| Term::from_field_text(fields.text, &self.parts[index]))
            .collect()
    }

    /// Whether one token can match both this one-token phrase and `other`, so it could be marked
    /// twice.
    pub fn can_share_a_token_with(&self, other: &Phrase) -> bool {
        let (Some(mine), Some(theirs)) = (self.parts.first(), other.parts.first()) else {
            return false;
        };
        match (self.ends_in_prefix, other.ends_in_prefix) {
            (false, false) => mine == theirs,
            (true, false) => theirs.starts_with(mine.as_str()),
            (false, true) => mine.starts_with(theirs.as_str()),
            (true, true) => mine.starts_with(theirs.as_str()) || theirs.starts_with(mine.as_str()),
        }
    }
}
