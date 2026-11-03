//! Where each value a workflow's `Run a command` step fills into its line lands, and the line the
//! step runs with each fill replaced by a reference to the environment variable that carries it,
//! written in the step's shell's own form, so a value never becomes command text. Each fill is
//! read as a placeholder word, under bash's grammar, PowerShell's grammar and a scan of csh's
//! quotes. The nearest quoting around a fill decides its place: none gives the shell's bare-word
//! form, an expanding string or an unquoted here-document body its in-string form, and a place
//! where no reference expands, or one a reading cannot show expanding as one value, refuses it.
//! A save runs all three readings, since the shell is known only at launch; a launch runs its
//! shell's alone.
//!
//! Accepted as they stand, never refused: a variable an earlier statement gave bash's integer
//! attribute, as `declare -i n` before `n={{ x }}`; a fill in a word a program the author named
//! runs as code: an `eval`, `source` or `-c` argument, `trap`'s action, `mapfile -C`'s callback,
//! PowerShell's `iex` or `Invoke-Expression`, `watch`'s command and `ssh`'s remote command;
//! cmd.exe's own re-parsing forms, a nested `cmd /c`, a
//! `for /f` command set and a `call` whose batch file splices its arguments into its lines; a
//! fill standing as the command name, which picks the program the line runs; and under csh a fill
//! in `@` or a name word of `set`, `setenv` or `unset`, whose `:q` reference quotes every character
//! of the value.

mod bash;
mod cmd;
mod csh;
mod powershell;

use std::ops::Range;

use sidekicks_contracts::workflow::definition::expression_template::{
    ExpressionTemplate, TemplatePart,
};

use super::{ShellGrammar, ShellLineReader};

/// What every fill variable's name starts with, its number following.
const FILL_VARIABLE_PREFIX: &str = "SIDEKICKS_VALUE_";

/// What every placeholder starts with: ASCII letters, its one capital first, so no placeholder can
/// begin inside another's text or the author's.
const PLACEHOLDER_STEM: &str = "Sidekicksfill";

/// cmd.exe's own cap, in UTF-16 units, on one inherited variable and on its line after every
/// expansion.
const CMD_EXPANSION_LIMIT: usize = 8_191;

/// The name of the environment variable that carries fill `number`, counted from 1 in line order:
/// `SIDEKICKS_VALUE_<number>`.
pub fn fill_variable_name(number: usize) -> String {
    format!("{FILL_VARIABLE_PREFIX}{number}")
}

/// The shell's own cap, in UTF-16 units, on one value it inherits and on its line after every
/// expansion, which a launch checks besides the system's caps: cmd.exe's 8,191, since it ignores a
/// longer inherited variable; `None` for every other shell.
pub fn shell_expansion_limit(shell: ShellGrammar) -> Option<usize> {
    match shell {
        ShellGrammar::Cmd => Some(CMD_EXPANSION_LIMIT),
        ShellGrammar::Posix(_)
        | ShellGrammar::Fish
        | ShellGrammar::Csh
        | ShellGrammar::PowerShell => None,
    }
}

/// Why a fill is refused: the rule of the place a reading found it in.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum FillRefusal {
    /// A reading could not read the line whole: a syntax error, or a line past the reading bound.
    #[error(
        "is on a line a reading could not read whole, which holds a syntax error or is too long"
    )]
    NotWhole,
    /// A here-document on the line does not end where bash ends it.
    #[error(
        "is on a line whose here-document ending at `{delimiter}` does not end where bash ends it; \
         end it on a line that is exactly `{delimiter}`"
    )]
    HereDocumentEnd {
        /// The delimiter as bash reads it.
        delimiter: String,
    },
    /// Single quotes, `$'…'`, a quoted here-document's body or a PowerShell verbatim string.
    #[error(
        "sits in single quotes, `$'…'`, a quoted here-document or a verbatim string, where \
         nothing expands"
    )]
    NotExpanding,
    /// Shell arithmetic, which evaluates the value as an expression.
    #[error("sits in shell arithmetic, which would evaluate the value as an expression")]
    Arithmetic,
    /// An array's `[…]` subscript, in a reference or an element, which bash evaluates as
    /// arithmetic, or as a key for an associative array.
    #[error(
        "sits in an array's `[…]` subscript, which bash evaluates as arithmetic or reads as a \
         key"
    )]
    ArraySubscript,
    /// A word a builtin reads as a variable name, whose subscript the shell evaluates.
    #[error(
        "sits in a word a builtin reads as a variable name, whose subscript the shell evaluates"
    )]
    NameWord,
    /// Backquotes inside an expanding string or holding a backslash, or csh's backquotes.
    #[error("sits in backquotes, whose text the shell reads again")]
    Backquoted,
    /// A comment.
    #[error("sits in a comment")]
    Comment,
    /// After PowerShell's `--%`, which passes the rest of the line as text.
    #[error("sits after PowerShell's `--%`, which passes the rest of the line as text")]
    StopParsing,
    /// Inside `${…}`, which PowerShell reads as one variable's name.
    #[error("sits in `${{…}}`, which PowerShell reads as one variable's name")]
    BracedVariable,
    /// Inside bash's `${ …; }` or `${| …; }`, which runs a command in the shell itself.
    #[error("sits in bash's `${{ …; }}`, which runs a command in the shell itself")]
    CommandInExpansion,
    /// Right after an escape character, which would quote the reference's first character: a
    /// backslash or PowerShell's backquote.
    #[error(
        "sits right after an escape character, which would quote the reference; to end a folder \
         before it, write `/` or `\\\\`"
    )]
    Escaped,
    /// Right after a variable's name, which reads the placeholder as more of that name.
    #[error(
        "sits right after `${name}`, which reads it as part of that variable's name; write \
         `${{{name}}}` to end the name"
    )]
    JoinedToVariable {
        /// The variable's name.
        name: String,
    },
    /// Right after cmd.exe's `^` outside double quotes, which quotes the reference's first
    /// character.
    #[error(
        "sits right after `^`, which cmd.exe reads as quoting the next character; put the fill in \
         double quotes, where cmd.exe reads `^` as plain text"
    )]
    CmdCaret,
    /// The modifier text of cmd.exe's `%NAME:…%` reference, which its first phase reads as the
    /// text of a `~` substring or `=` substitution form.
    #[error(
        "sits in the modifier text of cmd.exe's `%NAME:~…%` or `%NAME:…=…%`, where nothing \
         expands"
    )]
    CmdReferenceModifier,
    /// A csh here-document's body, whose substituted text csh reads again.
    #[error("sits in a csh here-document, whose substituted text csh reads again")]
    CshHereDocumentBody,
    /// Any other place: a name, a descriptor, or a node no rule names.
    #[error("sits where a reading does not show it expanding as one value")]
    UnreadPlace,
}

/// A fill a launch refused, with the rule that refused it.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("Fill {number} {refusal}.")]
pub struct RefusedFill {
    /// The fill's number, counted from 1 in line order.
    pub number: usize,
    /// Why it was refused.
    pub refusal: FillRefusal,
}

/// Where a reading placed a fill that expands.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FillPlace {
    /// A word, or a word joined to unquoted text.
    Bare,
    /// Inside an expanding string or an unquoted here-document body.
    InString,
    /// The whole command name, which PowerShell runs through its call operator.
    CommandName,
    /// The start of a token going on for `rest_length` bytes past the fill, which the launch
    /// writes as one double-quoted string: its opening quote, the in-string form and the rest.
    OpensString {
        /// The token's length past the fill, in bytes of the line.
        rest_length: usize,
    },
}

/// A reading's answer for one fill.
type FillPlacing = Result<FillPlace, FillRefusal>;

/// A command step's line as every reading reads it: the template's text parts as written, with
/// each fill a placeholder word of ASCII letters and digits that the author's text does not hold.
/// It owns its text, so it moves into the reading bound's work.
pub struct CommandLineFills {
    line: String,
    placeholders: Vec<Range<usize>>,
}

impl CommandLineFills {
    /// The line of `template`, its expressions the fills in order.
    pub fn new(template: &ExpressionTemplate<'_>) -> Self {
        let stem = placeholder_stem(template.parts());
        let mut line = String::new();
        let mut placeholders = Vec::new();
        for part in template.parts() {
            match part {
                TemplatePart::Text(text) => line.push_str(text),
                TemplatePart::Expression(_) => {
                    let start = line.len();
                    line.push_str(&stem);
                    line.push_str(&(placeholders.len() + 1).to_string());
                    line.push('x');
                    placeholders.push(start..line.len());
                }
            }
        }
        Self { line, placeholders }
    }

    /// The length in bytes of the line every reading reads, which the reading bound holds.
    pub fn line_length(&self) -> usize {
        self.line.len()
    }

    /// Each fill's verdict at save, in line order: accepted only where the bash reading, its
    /// cmd.exe form, the PowerShell reading and the csh scan all place it, else refused with the
    /// first refusal among them. Runs inside one read of the reading bound.
    pub fn check_for_save(&self, reader: &mut ShellLineReader) -> Vec<Result<(), FillRefusal>> {
        let bash = bash::place_fills(reader, self);
        let cmd = self.refuse_cmd_only_places(bash.clone());
        let powershell = powershell::place_fills(reader, self);
        let csh = csh::place_fills(reader, self);
        bash.into_iter()
            .zip(cmd)
            .zip(powershell)
            .zip(csh)
            .map(|(((bash, cmd), powershell), csh)| {
                bash.and(cmd).and(powershell).and(csh).map(|_| ())
            })
            .collect()
    }

    /// The line `shell` runs, built from the template's own text with each fill replaced by its
    /// variable's reference in that shell's form for the fill's place: the bash reading places it
    /// for a POSIX shell and cmd.exe, the PowerShell reading for PowerShell and the csh scan for
    /// csh, and fish takes `"$V"` everywhere; under cmd.exe the author's `^` and `!` are escaped
    /// where delayed expansion would read them, and an author's `%…%` reference to a variable
    /// `environment` defines is written so the command gets the value the author's line gives it;
    /// `environment` is the launch's names and values, which only cmd.exe reads, its names
    /// compared as Windows does, ignoring case. Fails with the first fill the reading refuses.
    /// Runs inside one read of the reading bound.
    pub fn fill_for_launch(
        &self,
        reader: &mut ShellLineReader,
        shell: ShellGrammar,
        environment: &[(&str, &str)],
    ) -> Result<String, RefusedFill> {
        let placings = match shell {
            ShellGrammar::Posix(_) => bash::place_fills(reader, self),
            ShellGrammar::Cmd => self.refuse_cmd_only_places(bash::place_fills(reader, self)),
            ShellGrammar::PowerShell => powershell::place_fills(reader, self),
            ShellGrammar::Csh => csh::place_fills(reader, self),
            ShellGrammar::Fish => vec![Ok(FillPlace::Bare); self.placeholders.len()],
        };
        let mut filled = String::with_capacity(self.line.len());
        let mut references = Vec::with_capacity(self.placeholders.len());
        let mut kept_from = 0;
        // Where the string a fill opened closes, in bytes of the line.
        let mut string_end = None;
        for (index, (placeholder, placing)) in self.placeholders.iter().zip(placings).enumerate() {
            let number = index + 1;
            let place = placing.map_err(|refusal| RefusedFill { number, refusal })?;
            if let Some(end) = string_end.take_if(|end| *end <= placeholder.start) {
                filled.push_str(&self.line[kept_from..end]);
                filled.push('"');
                kept_from = end;
            }
            filled.push_str(&self.line[kept_from..placeholder.start]);
            let reference_start = filled.len();
            filled.push_str(&reference(shell, place, number));
            references.push(reference_start..filled.len());
            if let FillPlace::OpensString { rest_length } = place {
                string_end = Some(placeholder.end + rest_length);
            }
            kept_from = placeholder.end;
        }
        if let Some(end) = string_end {
            filled.push_str(&self.line[kept_from..end]);
            filled.push('"');
            kept_from = end;
        }
        filled.push_str(&self.line[kept_from..]);
        Ok(match shell {
            ShellGrammar::Cmd => {
                cmd::keep_through_delayed_expansion(&filled, &references, environment)
            }
            ShellGrammar::Posix(_)
            | ShellGrammar::Fish
            | ShellGrammar::Csh
            | ShellGrammar::PowerShell => filled,
        })
    }

    /// The bash reading's `placings` as cmd.exe takes them: a fill in a `%NAME:…%` reference's
    /// substring or substitution form, which never reaches the command, refused, and then a fill
    /// right after a `^` that cmd.exe reads as an escape, which would quote the reference's first
    /// character.
    fn refuse_cmd_only_places(&self, placings: Vec<FillPlacing>) -> Vec<FillPlacing> {
        placings
            .into_iter()
            .zip(&self.placeholders)
            .map(|(placing, placeholder)| {
                if cmd::is_in_reference_modifier(&self.line, placeholder) {
                    Err(FillRefusal::CmdReferenceModifier)
                } else if cmd::follows_a_cmd_escape(&self.line, placeholder.start) {
                    Err(FillRefusal::CmdCaret)
                } else {
                    placing
                }
            })
            .collect()
    }

    /// The line every reading reads.
    fn line(&self) -> &str {
        &self.line
    }

    /// Every fill refused for `refusal`, as a reading that could not read the line answers.
    fn refuse_all(&self, refusal: &FillRefusal) -> Vec<FillPlacing> {
        vec![Err(refusal.clone()); self.placeholders.len()]
    }

    /// Where each placeholder lies in `text`, the line as a reading changed it around its
    /// placeholders, found in order; `None` when one is not there whole.
    fn placeholders_in(&self, text: &str) -> Option<Vec<Range<usize>>> {
        let mut from = 0;
        self.placeholders
            .iter()
            .map(|placeholder| {
                let word = &self.line[placeholder.clone()];
                let start = from + text.get(from..)?.find(word)?;
                from = start + word.len();
                Some(start..from)
            })
            .collect()
    }
}

/// The placeholders' stem: `Sidekicksfill`, with a `q` added for as long as the author's text
/// holds it. Each placeholder is the stem, its number and an `x`, so no placeholder is a prefix of
/// another.
fn placeholder_stem(parts: &[TemplatePart<'_>]) -> String {
    let mut stem = PLACEHOLDER_STEM.to_owned();
    while parts
        .iter()
        .any(|part| matches!(part, TemplatePart::Text(text) if text.contains(stem.as_str())))
    {
        stem.push('q');
    }
    stem
}

/// The reference to fill `number`'s variable that `shell` expands at `place`; for a fill opening a
/// string, the string's opening quote and the in-string form, the launch closing it.
fn reference(shell: ShellGrammar, place: FillPlace, number: usize) -> String {
    let name = fill_variable_name(number);
    match (shell, place) {
        (ShellGrammar::Posix(_), FillPlace::Bare | FillPlace::CommandName) => {
            format!("\"${{{name}}}\"")
        }
        (ShellGrammar::Posix(_), FillPlace::InString) => format!("${{{name}}}"),
        (ShellGrammar::PowerShell, FillPlace::Bare) => format!("\"${{env:{name}}}\""),
        (ShellGrammar::PowerShell, FillPlace::InString) => format!("${{env:{name}}}"),
        (ShellGrammar::PowerShell, FillPlace::CommandName) => format!("& \"${{env:{name}}}\""),
        (ShellGrammar::Fish, FillPlace::Bare | FillPlace::InString | FillPlace::CommandName) => {
            format!("\"${name}\"")
        }
        (ShellGrammar::Cmd, FillPlace::Bare | FillPlace::CommandName) => format!("\"!{name}!\""),
        (ShellGrammar::Cmd, FillPlace::InString) => format!("!{name}!"),
        (ShellGrammar::Csh, FillPlace::Bare | FillPlace::CommandName) => {
            format!("\"${{{name}:q}}\"")
        }
        (ShellGrammar::Csh, FillPlace::InString) => format!("${{{name}:q}}"),
        (shell, FillPlace::OpensString { .. }) => {
            format!("\"{}", reference(shell, FillPlace::InString, number))
        }
    }
}

/// Whether the byte before `at` in `text` is an escape character `escape` not itself escaped: an
/// odd run of them, which would quote the reference's first character.
fn is_escaped(text: &str, at: usize, escape: u8) -> bool {
    let run = text.as_bytes()[..at]
        .iter()
        .rev()
        .take_while(|&&byte| byte == escape)
        .count();
    run % 2 == 1
}

/// The name of the variable `$NAME` the text before `at` ends with, which reads the placeholder
/// as more of that name; `None` when it ends with none.
fn variable_before(text: &str, at: usize) -> Option<&str> {
    let before = &text[..at];
    let start = before
        .trim_end_matches(|character: char| character.is_ascii_alphanumeric() || character == '_')
        .len();
    let name = &before[start..];
    let starts_a_name = name
        .chars()
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic() || first == '_');
    (starts_a_name && before[..start].ends_with('$')).then_some(name)
}

/// Whether the text before `at` ends with `$` or `${`, which reads the placeholder as a variable's
/// name.
fn follows_a_dollar(text: &str, at: usize) -> bool {
    let before = &text[..at];
    before.ends_with('$') || before.ends_with("${")
}

#[cfg(test)]
mod tests;
