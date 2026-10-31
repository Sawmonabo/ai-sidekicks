//! The words a line the parser did not read whole still shows, read by a token scan: split at
//! blanks and at the shell's operators outside quotes, its quotes and backslashes dropped, its
//! ANSI-C strings decoded, zsh's `=name` read as the name, a comment left out, and the value
//! `env -S` splits put in its place as the words env splits it into.

use std::collections::VecDeque;
use std::iter::Peekable;
use std::str::Chars;

use super::listed_programs::command_wrapper;
use super::words::{WordBuilder, decode_ansi_c};
use super::{ShellLineReading, starts_variable_name};

impl ShellLineReading {
    /// The line's words as the parser left them unread, split at blanks and at the shell's
    /// operators outside quotes, into the runs between those operators: each word with its quotes
    /// and backslashes dropped and its ANSI-C strings decoded, quoted text one word with the text
    /// beside it, a word `=name` read as `name`, whose path zsh puts there, and a comment's words,
    /// from a `#` that starts a word outside quotes to the line's end, left out; in each run the
    /// value of an `env -S` is put in its place as the words env splits it into. What a line not
    /// read whole still shows of its commands.
    pub fn unread_word_runs(&self) -> Vec<Vec<String>> {
        let mut runs = WordRuns {
            runs: vec![Vec::new()],
            word: String::new(),
        };
        let mut quote = None;
        let mut is_escaped = false;
        let mut is_word_start = true;
        let mut is_comment = false;
        let mut characters = self.line.chars().peekable();
        while let Some(character) = characters.next() {
            if is_comment && character != '\n' {
                continue;
            }
            is_comment = false;
            let was_escaped = std::mem::take(&mut is_escaped);
            let was_word_start = std::mem::replace(&mut is_word_start, false);
            let is_bare = quote.is_none() && !was_escaped;
            match character {
                '#' if is_bare && was_word_start => is_comment = true,
                '$' if is_bare && characters.peek() == Some(&'\'') => {
                    characters.next();
                    let decoded = ansi_c_text(&mut characters);
                    runs.word.push_str(&decoded);
                }
                // zsh puts the path of the program `name` in place of `=name`, ending in the name.
                '=' if is_bare
                    && was_word_start
                    && characters
                        .peek()
                        .is_some_and(|&next| starts_variable_name(next)) => {}
                '\'' | '"' if !was_escaped => {
                    quote = match quote {
                        None => Some(character),
                        Some(open) if open == character => None,
                        open => open,
                    };
                }
                '\\' if !was_escaped && quote != Some('\'') => is_escaped = true,
                other if !is_bare => runs.word.push(other),
                other => {
                    runs.push(other);
                    is_word_start = is_operator(other) || other.is_whitespace();
                }
            }
        }
        runs.end_word();
        let mut split_bytes_left = self.line.len();
        runs.runs
            .into_iter()
            .filter(|run| !run.is_empty())
            .map(|run| with_split_strings(run, &mut split_bytes_left))
            .collect()
    }
}

// The runs read so far and the word being read into the last of them.
struct WordRuns {
    runs: Vec<Vec<String>>,
    word: String,
}

impl WordRuns {
    // Reads `character` into the runs: an operator ends the run, a blank the word, and any other
    // character goes into the word.
    fn push(&mut self, character: char) {
        if is_operator(character) {
            self.end_word();
            self.runs.push(Vec::new());
        } else if character.is_whitespace() {
            self.end_word();
        } else {
            self.word.push(character);
        }
    }

    // Ends the word being read into the last run, if it holds any character.
    fn end_word(&mut self) {
        if !self.word.is_empty()
            && let Some(run) = self.runs.last_mut()
        {
            run.push(std::mem::take(&mut self.word));
        }
    }
}

// The characters at which the shell ends a command, or starts a redirect or substitution.
fn is_operator(character: char) -> bool {
    matches!(
        character,
        ';' | '&' | '|' | '(' | ')' | '<' | '>' | '`' | '\n'
    )
}

// The text of an ANSI-C string whose `$'` is taken, up to its closing quote: decoded as bash and
// zsh decode it alike, or else with each backslash dropped before the character it escapes, as zsh
// reads an escape it does not know.
fn ansi_c_text(characters: &mut Peekable<Chars<'_>>) -> String {
    let mut body = String::new();
    let mut is_escaped = false;
    for character in characters.by_ref() {
        if character == '\'' && !is_escaped {
            break;
        }
        is_escaped = character == '\\' && !is_escaped;
        body.push(character);
    }
    let mut text = String::new();
    if decode_ansi_c(&body, &mut text) {
        return text;
    }
    text.clear();
    let mut body_characters = body.chars();
    while let Some(character) = body_characters.next() {
        let kept = match character {
            '\\' => body_characters.next(),
            other => Some(other),
        };
        text.extend(kept);
    }
    text
}

// `run` with each value `env -S` splits, the rest of the option's word or the word after it, put
// in its place as the words env splits it into, which env reads again as its own; a value env
// refuses stays as it is. The values split read at most `split_bytes_left` bytes in all, the
// line's length, so a scan's time grows with its line.
fn with_split_strings(run: Vec<String>, split_bytes_left: &mut usize) -> Vec<String> {
    let mut pending: VecDeque<String> = run.into();
    let mut words = Vec::with_capacity(pending.len());
    let mut env = None;
    while let Some(mut word) = pending.pop_front() {
        let Some(wrapper) = env.filter(|_| word.starts_with('-') && word != "--") else {
            // A word that is no option of env's ends them: env's program, or another word.
            let name = word.rsplit('/').next().unwrap_or(&word);
            env = if name == "env" {
                command_wrapper(name)
            } else {
                None
            };
            words.push(word);
            continue;
        };
        let Some((attached_from, splits)) = wrapper.option_value(&word) else {
            words.push(word);
            continue;
        };
        let value = match attached_from {
            Some(bytes) => Some(word.split_off(bytes)),
            None => pending.pop_front(),
        };
        words.push(word);
        let Some(value) = value else {
            continue;
        };
        let split = (splits && value.len() <= *split_bytes_left)
            .then(|| WordBuilder::split_string_text(&value))
            .flatten();
        match split {
            Some(split_words) => {
                *split_bytes_left -= value.len();
                for split_word in split_words.into_iter().rev() {
                    pending.push_front(split_word);
                }
            }
            None => words.push(value),
        }
    }
    words
}
