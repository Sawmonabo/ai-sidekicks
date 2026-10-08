//! The index's tokenizer: splits text on Unicode letters and digits and folds case and every
//! diacritic, keeping where each token sat in the source text.

use caseless::Caseless;
use tantivy::tokenizer::MAX_TOKEN_LEN;
use unicode_normalization::char::{decompose_canonical, is_combining_mark};
use unicode_properties::{GeneralCategoryGroup, UnicodeGeneralCategory};

/// One token of a text: its folded form as the index holds it and where it came from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TextToken {
    /// The token after canonical decomposition, combining marks removed and full case folding.
    pub folded: String,
    /// The token's place among the text's tokens; a token too long to index leaves its place empty.
    pub position: u32,
    /// The token's first UTF-16 code unit in the source text.
    pub start: u32,
    /// One past the token's last UTF-16 code unit in the source text.
    pub end: u32,
}

/// Splits `text` into folded tokens in order. A token starts at a letter or a digit and runs
/// through letters, digits and combining marks, so a decomposed accent stays inside its word. A
/// token whose folded form is longer than Tantivy indexes is dropped, as Tantivy would drop it,
/// keeping its place.
pub fn tokenize(text: &str) -> Vec<TextToken> {
    let mut tokens = Vec::new();
    let mut position = 0u32;
    let mut offset = 0u32;
    let mut open: Option<(String, u32)> = None;
    for character in text.chars() {
        let group = character.general_category_group();
        let starts = matches!(
            group,
            GeneralCategoryGroup::Letter | GeneralCategoryGroup::Number
        );
        let continues = starts || matches!(group, GeneralCategoryGroup::Mark);
        match open.as_mut() {
            Some((folded, _)) if continues => fold_into(character, folded),
            _ => {
                if let Some((folded, start)) = open.take() {
                    close_token(&mut tokens, &mut position, folded, start, offset);
                }
                if starts {
                    let mut folded = String::new();
                    fold_into(character, &mut folded);
                    open = Some((folded, offset));
                }
            }
        }
        offset += character.len_utf16() as u32;
    }
    if let Some((folded, start)) = open {
        close_token(&mut tokens, &mut position, folded, start, offset);
    }
    tokens
}

fn close_token(
    tokens: &mut Vec<TextToken>,
    position: &mut u32,
    folded: String,
    start: u32,
    end: u32,
) {
    if !folded.is_empty() && folded.len() <= MAX_TOKEN_LEN {
        tokens.push(TextToken {
            folded,
            position: *position,
            start,
            end,
        });
    }
    *position += 1;
}

// Canonical decomposition, combining marks removed, then full case folding; folding can itself
// produce a letter with a combining mark, which is decomposed and dropped the same way.
fn fold_into(character: char, folded: &mut String) {
    if character.is_ascii() {
        folded.push(character.to_ascii_lowercase());
        return;
    }
    decompose_canonical(character, |part| {
        if is_combining_mark(part) {
            return;
        }
        for case_folded in std::iter::once(part).default_case_fold() {
            decompose_canonical(case_folded, |piece| {
                if !is_combining_mark(piece) {
                    folded.push(piece);
                }
            });
        }
    });
}

/// The first `length` characters of `token`, or `None` when it is shorter.
pub fn prefix_of(token: &str, length: usize) -> Option<&str> {
    match token.char_indices().nth(length) {
        Some((end, _)) => Some(&token[..end]),
        None => (token.chars().count() == length).then_some(token),
    }
}
