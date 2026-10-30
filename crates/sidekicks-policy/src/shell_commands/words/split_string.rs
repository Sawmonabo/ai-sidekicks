//! The words `env -S` splits its value into, as env reads the string: blanks outside quotes part
//! the words, single and double quotes are taken off, the escapes env lists are undone, a word that
//! starts with `#` ends the string, and so does `\c`. A `${name}` env expands, and an expansion the
//! shell made in the value, each make their word one only the run decides.

use super::{Piece, PieceKind, Word, WordBuilder, offset, push_piece, word_from};

// One part of the value: a character with the range it spans in the text its piece indexes, or an
// expansion the shell made, whose text only the run decides.
#[derive(Clone, Copy)]
enum ValuePart {
    Character { character: char, piece: Piece },
    Expansion(Piece),
}

// The quotes the split is inside.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Quote {
    Single,
    Double,
}

impl WordBuilder<'_> {
    /// The words env reads in place of `word`, its `-S` value; `None` when env refuses the value,
    /// or an expansion the shell made in it may make env refuse it, so no split is read. env
    /// refuses a quote left open, a backslash before a character it lists no escape for or ending
    /// the string, a `$` that does not start `${name}`, and `\c` inside double quotes; a line
    /// break, vertical tab, form feed or carriage return outside quotes is a blank, as a space is,
    /// to GNU and macOS env alike. Once the reading's splits, nested ones included, would read
    /// more bytes in all than its line holds, no further split is read, so a reading's time grows
    /// with its line, and the reading is not whole.
    pub(in crate::shell_commands) fn split_string(&mut self, word: Word) -> Option<Vec<Word>> {
        let length = self.view(word).len();
        let Some(bytes_left) = self.split_bytes_left.checked_sub(length) else {
            self.is_split_past_bound = true;
            return None;
        };
        self.split_bytes_left = bytes_left;
        let parts = self.value_parts(word);
        let (piece_mark, decoded_mark) = (self.pieces.len(), self.decoded.len());
        let words = self.split_parts(&parts);
        if words.is_none() {
            self.pieces.truncate(piece_mark);
            self.decoded.truncate(decoded_mark);
        }
        words
    }

    fn value_parts(&self, word: Word) -> Vec<ValuePart> {
        let mut parts = Vec::new();
        for &piece in &self.pieces[word.pieces()] {
            if piece.kind.is_expansion() {
                parts.push(ValuePart::Expansion(piece));
                continue;
            }
            let source = if piece.kind.is_in_decoded() {
                self.decoded.as_str()
            } else {
                self.line
            };
            let text = &source[piece.start as usize..piece.end as usize];
            parts.extend(text.char_indices().map(|(position, character)| {
                let start = piece.start + offset(position);
                ValuePart::Character {
                    character,
                    piece: Piece {
                        start,
                        end: start + offset(character.len_utf8()),
                        kind: piece.kind,
                    },
                }
            }));
        }
        parts
    }

    fn split_parts(&mut self, parts: &[ValuePart]) -> Option<Vec<Word>> {
        let mut words = Vec::new();
        // The first piece of the word being built, once one is started.
        let mut word_start: Option<usize> = None;
        let mut quote = None;
        let mut index = 0;
        while let Some(&part) = parts.get(index) {
            index += 1;
            let (character, piece) = match part {
                // env splits the expanded text again, so a quoted expansion can split as well.
                ValuePart::Expansion(mut piece) => {
                    if piece.kind == PieceKind::QuotedExpansion {
                        piece.kind = PieceKind::Expansion;
                    }
                    word_start.get_or_insert(self.pieces.len());
                    self.pieces.push(piece);
                    continue;
                }
                ValuePart::Character { character, piece } => (character, piece),
            };
            match (character, quote) {
                ('\'', None | Some(Quote::Single)) => {
                    quote = toggled(quote, Quote::Single);
                    word_start.get_or_insert(self.pieces.len());
                }
                ('"', None | Some(Quote::Double)) => {
                    quote = toggled(quote, Quote::Double);
                    word_start.get_or_insert(self.pieces.len());
                }
                (' ' | '\t' | '\n' | '\u{b}' | '\u{c}' | '\r', None) => {
                    self.end_word(&mut word_start, &mut words);
                }
                ('#', None) if word_start.is_none() => break,
                // Inside single quotes only `\\` and `\'` are escapes.
                ('\\', Some(Quote::Single))
                    if !matches!(
                        parts.get(index),
                        Some(ValuePart::Character {
                            character: '\\' | '\'',
                            ..
                        })
                    ) =>
                {
                    self.push_split_piece(&mut word_start, piece);
                }
                ('\\', _) => {
                    let Some(&ValuePart::Character {
                        character: escaped,
                        piece: escaped_piece,
                    }) = parts.get(index)
                    else {
                        return None;
                    };
                    index += 1;
                    let decoded = match escaped {
                        '"' | '#' | '$' | '\'' | '\\' => {
                            self.push_split_piece(&mut word_start, escaped_piece);
                            continue;
                        }
                        '_' if quote.is_none() => {
                            self.end_word(&mut word_start, &mut words);
                            continue;
                        }
                        '_' => ' ',
                        'c' if quote.is_none() => break,
                        'f' => '\u{c}',
                        'n' => '\n',
                        'r' => '\r',
                        't' => '\t',
                        'v' => '\u{b}',
                        _ => return None,
                    };
                    self.push_decoded_character(&mut word_start, decoded);
                }
                ('$', None | Some(Quote::Double)) => {
                    let end = index + expansion_length(&parts[index..])?;
                    for &part in &parts[index - 1..end] {
                        if let ValuePart::Character { mut piece, .. } = part {
                            piece.kind = if piece.kind.is_in_decoded() {
                                PieceKind::DecodedExpansion
                            } else {
                                PieceKind::Expansion
                            };
                            self.push_split_piece(&mut word_start, piece);
                        }
                    }
                    index = end;
                }
                _ => self.push_split_piece(&mut word_start, piece),
            }
        }
        if quote.is_some() {
            return None;
        }
        self.end_word(&mut word_start, &mut words);
        Some(words)
    }

    // Adds `piece` to the word being built, starting one if none is, and joins it to the word's
    // last piece when it continues that piece's text.
    fn push_split_piece(&mut self, word_start: &mut Option<usize>, piece: Piece) {
        let first_piece = *word_start.get_or_insert(self.pieces.len());
        if self.pieces.len() > first_piece
            && let Some(last) = self.pieces.last_mut()
            && last.kind == piece.kind
            && last.end == piece.start
        {
            last.end = piece.end;
            return;
        }
        push_piece(&mut self.pieces, piece.start, piece.end, piece.kind);
    }

    fn push_decoded_character(&mut self, word_start: &mut Option<usize>, character: char) {
        let start = offset(self.decoded.len());
        self.decoded.push(character);
        let piece = Piece {
            start,
            end: offset(self.decoded.len()),
            kind: PieceKind::Decoded,
        };
        self.push_split_piece(word_start, piece);
    }

    fn end_word(&self, word_start: &mut Option<usize>, words: &mut Vec<Word>) {
        if let Some(first_piece) = word_start.take() {
            words.push(word_from(&self.pieces, first_piece));
        }
    }
}

fn toggled(quote: Option<Quote>, toggle: Quote) -> Option<Quote> {
    match quote {
        Some(_) => None,
        None => Some(toggle),
    }
}

// The parts `{name}` spans after a `$`, as env reads `${name}`: a name of letters, digits and
// underscores that does not start with a digit; `None` when they hold no such name.
fn expansion_length(parts: &[ValuePart]) -> Option<usize> {
    let mut characters = parts.iter().map(|part| match part {
        ValuePart::Character { character, .. } => Some(*character),
        ValuePart::Expansion(_) => None,
    });
    if characters.next()? != Some('{') {
        return None;
    }
    let mut length = 1;
    for character in characters {
        length += 1;
        match character? {
            '}' if length > 2 => return Some(length),
            character if character == '_' || character.is_ascii_alphabetic() => {}
            character if character.is_ascii_digit() && length > 2 => {}
            _ => return None,
        }
    }
    None
}
