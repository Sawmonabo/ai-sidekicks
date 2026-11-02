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
//! attribute, as `declare -i n` before `n={{ x }}`; a fill in an `eval`, `source` or `-c` argument,
//! which the author's own line runs as code; cmd.exe's own re-parsing forms, a nested `cmd /c`, a
//! `for /f` command set and a `call` whose batch file splices its arguments into its lines; a
//! fill standing as the command name, which picks the program the line runs; and under csh a fill
//! in `@` or a name word of `set`, `setenv` or `unset`, whose `:q` reference quotes every character
//! of the value.

mod bash;
mod csh;
mod powershell;
#[cfg(test)]
mod tests;

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
        "sits in single quotes, `$'…'`, a quoted here-document or a verbatim string, where nothing expands"
    )]
    NotExpanding,
    /// Shell arithmetic, which evaluates the value as an expression.
    #[error("sits in shell arithmetic, which would evaluate the value as an expression")]
    Arithmetic,
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
    /// Right after an escape character, which would quote the reference's first character.
    #[error("sits right after an escape character, which would quote the reference")]
    Escaped,
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

    /// Each fill's verdict at save, in line order: accepted only where the bash reading, the
    /// PowerShell reading and the csh scan all place it, else refused with the first refusal
    /// among them. Runs inside one read of the reading bound.
    pub fn check_for_save(&self, reader: &mut ShellLineReader) -> Vec<Result<(), FillRefusal>> {
        let bash = bash::place_fills(reader, self);
        let powershell = powershell::place_fills(reader, self);
        let csh = csh::place_fills(reader, self);
        bash.into_iter()
            .zip(powershell)
            .zip(csh)
            .map(|((bash, powershell), csh)| bash.and(powershell).and(csh).map(|_| ()))
            .collect()
    }

    /// The line `shell` runs, built from the template's own text with each fill replaced by its
    /// variable's reference in that shell's form for the fill's place: the bash reading places it
    /// for a POSIX shell and cmd.exe, the PowerShell reading for PowerShell and the csh scan for
    /// csh, and fish takes `"$V"` everywhere. Fails with the first fill the reading refuses. Runs
    /// inside one read of the reading bound.
    pub fn fill_for_launch(
        &self,
        reader: &mut ShellLineReader,
        shell: ShellGrammar,
    ) -> Result<String, RefusedFill> {
        let placings = match shell {
            ShellGrammar::Posix(_) | ShellGrammar::Cmd => bash::place_fills(reader, self),
            ShellGrammar::PowerShell => powershell::place_fills(reader, self),
            ShellGrammar::Csh => csh::place_fills(reader, self),
            ShellGrammar::Fish => vec![Ok(FillPlace::Bare); self.placeholders.len()],
        };
        let mut filled = String::with_capacity(self.line.len());
        let mut kept_from = 0;
        for (index, (placeholder, placing)) in self.placeholders.iter().zip(placings).enumerate() {
            let number = index + 1;
            let place = placing.map_err(|refusal| RefusedFill { number, refusal })?;
            filled.push_str(&self.line[kept_from..placeholder.start]);
            filled.push_str(&reference(shell, place, number));
            kept_from = placeholder.end;
        }
        filled.push_str(&self.line[kept_from..]);
        Ok(filled)
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

/// The reference to fill `number`'s variable that `shell` expands at `place`.
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

/// Whether the text before `at` ends with `$` or `${`, which reads the placeholder as a variable's
/// name.
fn follows_a_dollar(text: &str, at: usize) -> bool {
    let before = &text[..at];
    before.ends_with('$') || before.ends_with("${")
}
