//! How getopt reads an option word: a long option by its name or a prefix of one, and a short
//! cluster up to the letter that takes a value.

use super::WordText;

/// Whether `word` is `option`, alone or with `=<value>`; `option` is ASCII, so its byte length
/// counts its characters.
pub fn is_option(word: impl WordText, option: &str) -> bool {
    word.starts_with(option) && matches!(word.chars().nth(option.len()), None | Some('='))
}

/// The option of `options` the long option word `word` names, as `getopt_long` reads it: the one
/// it names whole, or else the one its name, up to any `=`, is a prefix of when that prefix fits
/// no other; with the byte offset of a value attached after `=`.
pub(in crate::shell_commands) fn long_option_named<'o, T>(
    word: impl WordText,
    options: impl Iterator<Item = (&'o str, T)>,
) -> Option<(T, Option<usize>)> {
    let mut prefixed = None;
    let mut prefix_count = 0;
    let mut named = None;
    for (option, value) in options {
        let mut option_characters = option.chars();
        let is_prefix = word
            .chars()
            .take_while(|&character| character != '=')
            .all(|character| option_characters.next() == Some(character));
        if !is_prefix {
            continue;
        }
        if option_characters.next().is_none() {
            named = Some(value);
            break;
        }
        prefix_count += 1;
        prefixed = Some(value);
    }
    let value = named.or(prefixed.filter(|_| prefix_count == 1))?;
    let mut name_length = 0;
    let mut characters = word.chars();
    let has_value = loop {
        match characters.next() {
            Some('=') => break true,
            Some(character) => name_length += character.len_utf8(),
            None => break false,
        }
    };
    Some((value, has_value.then_some(name_length + 1)))
}

/// The option of `options` the short cluster `word` names first, as getopt reads a cluster, with
/// the byte offset of its value when the rest of the cluster holds it; `None` when no letter is
/// listed before one of `letters_with_attached_value`, whose optional value is the cluster's rest.
pub(in crate::shell_commands) fn short_option_named<'o, T>(
    word: impl WordText,
    options: &(impl Iterator<Item = (&'o str, T)> + Clone),
    letters_with_attached_value: &str,
) -> Option<(T, Option<usize>)> {
    let mut position = 1;
    let mut letters = word.chars().skip(1).peekable();
    while let Some(letter) = letters.next() {
        position += letter.len_utf8();
        if letters_with_attached_value.contains(letter) {
            return None;
        }
        let named = options.clone().find(|&(option, _)| {
            let mut characters = option.chars();
            characters.next() == Some('-')
                && characters.next() == Some(letter)
                && characters.next().is_none()
        });
        if let Some((_, value)) = named {
            return Some((value, letters.peek().is_some().then_some(position)));
        }
    }
    None
}
