//! The index's fields, how a row becomes a document, and how owners are kept apart.

use tantivy::schema::{
    Field, IndexRecordOption, NumericOptions, Schema, TextFieldIndexing, TextOptions,
};
use tantivy::tokenizer::{PreTokenizedString, Token};
use tantivy::{TantivyDocument, Term};

use crate::IndexRowKind;
use crate::tokenizer::{prefix_of, tokenize};

/// The longest prefix with a field of its own; a longer prefix merges the whole-word terms it
/// begins.
pub const PREFIX_FIELD_COUNT: usize = 4;

/// A token no typed word can produce. It stands for a word shorter than a prefix field's length and
/// closes every row in every text field, so each field's token count is the row's length: its token
/// count plus one, the length BM25 normalizes by.
const FILLER: &str = "\u{1}";

/// The kind code an `event` row carries in the kind column.
pub const EVENT_KIND: u64 = 0;

/// The index's fields. The index stores no text: every field is indexed or a column.
#[derive(Clone, Copy, Debug)]
pub struct IndexFields {
    /// Each row's folded tokens with frequencies and positions, then the filler.
    pub text: Field,
    /// `prefixes[n - 1]` holds each token's first n characters, or the filler for a shorter token.
    pub prefixes: [Field; PREFIX_FIELD_COUNT],
    /// The row key, indexed so a replace or a removal deletes by its term.
    pub key: Field,
    /// The row's owner as `owner_value` encodes it, indexed so an owner's rows are found by term.
    pub owner: Field,
    pub kind: Field,
    /// The row's length: its token count plus one.
    pub length: Field,
}

/// The index's schema and its fields.
pub fn index_schema() -> (Schema, IndexFields) {
    let mut builder = Schema::builder();
    let text_indexing = text_options(IndexRecordOption::WithFreqsAndPositions);
    let text = builder.add_text_field("text", text_indexing);
    let prefixes = std::array::from_fn(|index| {
        let name = format!("p{}", index + 1);
        builder.add_text_field(&name, text_options(IndexRecordOption::WithFreqs))
    });
    let key = builder.add_u64_field("key", NumericOptions::default().set_indexed().set_fast());
    let owner = builder.add_u64_field("owner", NumericOptions::default().set_indexed().set_fast());
    let kind = builder.add_u64_field("kind", NumericOptions::default().set_fast());
    let length = builder.add_u64_field("length", NumericOptions::default().set_fast());
    (builder.build(), IndexFields { text, prefixes, key, owner, kind, length })
}

// Tokens arrive pre-tokenized, so the raw tokenizer named here never runs.
fn text_options(record: IndexRecordOption) -> TextOptions {
    TextOptions::default().set_indexing_options(
        TextFieldIndexing::default().set_tokenizer("raw").set_index_option(record),
    )
}

/// Whose rows a row is: a session's own, or a group's name row, which counts toward its members.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Owner {
    Session(u64),
    Group(u64),
}

/// The number the owner field holds: session and group keys share one number space, so a session
/// key is stored doubled and a group key doubled plus one.
pub fn owner_value(owner: Owner) -> u64 {
    match owner {
        Owner::Session(key) => key * 2,
        Owner::Group(key) => key * 2 + 1,
    }
}

/// The owner an owner field value names.
pub fn owner_of(value: u64) -> Owner {
    if value % 2 == 0 { Owner::Session(value / 2) } else { Owner::Group(value / 2) }
}

fn kind_code(kind: &IndexRowKind) -> u64 {
    match kind {
        IndexRowKind::Event => EVENT_KIND,
        IndexRowKind::Title => 1,
        IndexRowKind::Group => 2,
        IndexRowKind::Tag => 3,
    }
}

/// The term a row key is deleted by.
pub fn key_term(fields: &IndexFields, key: u64) -> Term {
    Term::from_field_u64(fields.key, key)
}

/// The term every row of an owner carries.
pub fn owner_term(fields: &IndexFields, owner: Owner) -> Term {
    Term::from_field_u64(fields.owner, owner_value(owner))
}

/// One row as a document: its folded tokens in the text field, their prefixes in the prefix fields,
/// and its key, owner, kind and length as columns.
pub fn row_document(
    fields: &IndexFields,
    key: u64,
    kind: &IndexRowKind,
    owner: Owner,
    text: &str,
) -> TantivyDocument {
    let tokens = tokenize(text);
    let filler_position = tokens.last().map_or(0, |token| token.position as usize + 1);
    let mut document = TantivyDocument::default();
    let words = tokens.iter().map(|token| (token.folded.as_str(), token.position as usize));
    document.add_pre_tokenized_text(fields.text, pre_tokenized(words, filler_position));
    for (index, field) in fields.prefixes.iter().enumerate() {
        let prefixes = tokens.iter().map(|token| {
            (prefix_of(&token.folded, index + 1).unwrap_or(FILLER), token.position as usize)
        });
        document.add_pre_tokenized_text(*field, pre_tokenized(prefixes, filler_position));
    }
    document.add_u64(fields.key, key);
    document.add_u64(fields.owner, owner_value(owner));
    document.add_u64(fields.kind, kind_code(kind));
    document.add_u64(fields.length, tokens.len() as u64 + 1);
    document
}

fn pre_tokenized<'a>(
    words: impl Iterator<Item = (&'a str, usize)>,
    filler_position: usize,
) -> PreTokenizedString {
    let tokens = words
        .chain(std::iter::once((FILLER, filler_position)))
        .map(|(text, position)| Token {
            offset_from: 0,
            offset_to: 0,
            position,
            text: text.to_string(),
            position_length: 1,
        })
        .collect();
    PreTokenizedString { text: String::new(), tokens }
}
