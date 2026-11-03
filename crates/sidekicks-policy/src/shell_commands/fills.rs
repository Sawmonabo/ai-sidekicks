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
        let cmd = self.refuse_after_cmd_escapes(bash.clone());
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
    /// where delayed expansion would read them, and there an author's `%NAME%` is written `!NAME!`
    /// when `is_defined`, asked only for cmd.exe, answers that the launch's environment defines
    /// `NAME`, comparing names as Windows does, ignoring case. Fails with the first fill the
    /// reading refuses. Runs inside one read of the reading bound.
    pub fn fill_for_launch(
        &self,
        reader: &mut ShellLineReader,
        shell: ShellGrammar,
        is_defined: &dyn Fn(&str) -> bool,
    ) -> Result<String, RefusedFill> {
        let placings = match shell {
            ShellGrammar::Posix(_) => bash::place_fills(reader, self),
            ShellGrammar::Cmd => self.refuse_after_cmd_escapes(bash::place_fills(reader, self)),
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
                cmd::keep_through_delayed_expansion(&filled, &references, is_defined)
            }
            ShellGrammar::Posix(_)
            | ShellGrammar::Fish
            | ShellGrammar::Csh
            | ShellGrammar::PowerShell => filled,
        })
    }

    /// The bash reading's `placings` as cmd.exe takes them: a fill right after a `^` that cmd.exe
    /// reads as an escape, which would quote the reference's first character, refused.
    fn refuse_after_cmd_escapes(&self, placings: Vec<FillPlacing>) -> Vec<FillPlacing> {
        placings
            .into_iter()
            .zip(&self.placeholders)
            .map(|(placing, placeholder)| {
                if cmd::follows_a_cmd_escape(&self.line, placeholder.start) {
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
mod tests {
    use std::path::Path;

    use rstest::rstest;
    use sidekicks_contracts::workflow::definition::expression_template::{
        TemplateText, read_template,
    };

    use super::*;
    use crate::shell_commands::shell_grammar_for_program;

    // Far past every line here, so only the limit case reaches a limit.
    const LIMIT: usize = 4_096;

    // The fills of a command step's line, written as its param holds it after the `=`.
    fn fills_of(line: &str) -> CommandLineFills {
        let text = format!("={line}");
        match read_template(&text).expect("each line here closes its parts") {
            TemplateText::Expression(template) => CommandLineFills::new(&template),
            TemplateText::Literal(_) => panic!("each line here is a template"),
        }
    }

    fn save(line: &str, limit: usize) -> Vec<Result<(), FillRefusal>> {
        fills_of(line).check_for_save(&mut ShellLineReader::new(limit))
    }

    fn launch(line: &str, shell: ShellGrammar) -> Result<String, RefusedFill> {
        fills_of(line).fill_for_launch(&mut ShellLineReader::new(LIMIT), shell, &|_| false)
    }

    fn grammar(program: &str) -> ShellGrammar {
        shell_grammar_for_program(Path::new(program)).expect("each program here is a listed shell")
    }

    // Each place a save accepts: a word, a word joined to unquoted text, a substitution's word, a
    // string's text, a substitution inside a string, escaped quotes around a fill, which every
    // reading takes as text beside a bare word, a `^` inside double quotes, which cmd.exe reads as
    // plain text, and a `^` cmd.exe's own `^` escapes.
    #[rstest]
    #[case::a_bare_word("echo {{ x }}")]
    #[case::joined_to_an_option("echo --name={{ x }}")]
    #[case::in_a_substitution("echo $(echo {{ x }})")]
    #[case::in_a_string("echo \"a {{ x }}\"")]
    #[case::in_a_substitution_in_a_string("echo \"$(echo {{ x }})\"")]
    #[case::between_escaped_quotes("echo \\\"{{ x }}\\\"")]
    #[case::an_unexported_value("export -n a={{ x }}")]
    #[case::a_caret_in_a_string("grep \"^{{ x }}\" file")]
    #[case::an_escaped_caret("echo ^^{{ x }}")]
    fn a_save_accepts_a_fill_where_every_reading_expands_it(#[case] line: &str) {
        assert_eq!(save(line, LIMIT), vec![Ok(())]);
    }

    // Each place a save refuses, with the rule that refuses it: the first reading's, bash, then
    // PowerShell, then csh. Arithmetic and name words refuse through a substitution too, since the
    // shell evaluates its output there.
    #[rstest]
    #[case::single_quotes("echo '{{ x }}'", FillRefusal::NotExpanding)]
    #[case::ansi_c_quotes("echo $'{{ x }}'", FillRefusal::NotExpanding)]
    #[case::typographic_quotes("echo ‘{{ x }}’", FillRefusal::NotExpanding)]
    #[case::backquotes_in_a_string("echo \"`echo {{ x }}`\"", FillRefusal::Backquoted)]
    #[case::stop_parsing("echo --% {{ x }}", FillRefusal::StopParsing)]
    #[case::a_comment("echo a # {{ x }}", FillRefusal::Comment)]
    #[case::a_braced_variable("echo ${p:-{{ x }}}", FillRefusal::BracedVariable)]
    #[case::a_variable_name("echo ${{ x }}", FillRefusal::UnreadPlace)]
    #[case::a_variable_joined_before("echo \"$HOME{{ x }}\"", FillRefusal::JoinedToVariable {
        name: "HOME".to_owned()
    })]
    #[case::a_cmd_escape("echo ^{{ x }}", FillRefusal::CmdCaret)]
    #[case::a_cmd_escape_after_an_escaped_quote("echo ^\"^{{ x }}^\"", FillRefusal::CmdCaret)]
    #[case::arithmetic_expansion("echo $(( {{ x }} ))", FillRefusal::Arithmetic)]
    #[case::arithmetic_expansion_quoted("echo $(( \"{{ x }}\" ))", FillRefusal::Arithmetic)]
    #[case::arithmetic_command("(( {{ x }} ))", FillRefusal::Arithmetic)]
    #[case::arithmetic_command_quoted("(( \"{{ x }}\" ))", FillRefusal::Arithmetic)]
    #[case::arithmetic_for(
        "for (( i = {{ x }}; i < 2; i++ )); do :; done",
        FillRefusal::Arithmetic
    )]
    #[case::arithmetic_for_quoted(
        "for (( i = \"{{ x }}\"; i < 2; i++ )); do :; done",
        FillRefusal::Arithmetic
    )]
    #[case::let_("let {{ x }}", FillRefusal::Arithmetic)]
    #[case::let_quoted("let \"{{ x }}\"", FillRefusal::Arithmetic)]
    #[case::declare_integer("declare -i n={{ x }}", FillRefusal::Arithmetic)]
    #[case::declare_integer_quoted("declare -i n=\"{{ x }}\"", FillRefusal::Arithmetic)]
    #[case::double_bracket_equal("[[ {{ x }} -eq 1 ]]", FillRefusal::Arithmetic)]
    #[case::double_bracket_equal_quoted("[[ \"{{ x }}\" -eq 1 ]]", FillRefusal::Arithmetic)]
    #[case::a_subscript("echo ${a[{{ x }}]}", FillRefusal::ArraySubscript)]
    #[case::a_subscript_quoted("echo \"${a[{{ x }}]}\"", FillRefusal::ArraySubscript)]
    #[case::an_offset("echo ${p:$(echo {{ x }})}", FillRefusal::Arithmetic)]
    #[case::an_offset_quoted("echo \"${p:$(echo {{ x }})}\"", FillRefusal::Arithmetic)]
    #[case::a_substitution_in_arithmetic("echo $(( $(echo {{ x }}) ))", FillRefusal::Arithmetic)]
    #[case::unset("unset {{ x }}", FillRefusal::NameWord)]
    #[case::unset_quoted("unset \"{{ x }}\"", FillRefusal::NameWord)]
    #[case::unset_a_substitution("unset $(echo {{ x }})", FillRefusal::NameWord)]
    #[case::read("read {{ x }}", FillRefusal::NameWord)]
    #[case::read_quoted("read -r \"{{ x }}\"", FillRefusal::NameWord)]
    #[case::printf_v("printf -v {{ x }} a", FillRefusal::NameWord)]
    #[case::printf_v_quoted("printf -v \"{{ x }}\" a", FillRefusal::NameWord)]
    #[case::declare("declare {{ x }}=1", FillRefusal::NameWord)]
    #[case::declare_quoted("declare \"{{ x }}=1\"", FillRefusal::NameWord)]
    #[case::test_v("test -v {{ x }}", FillRefusal::NameWord)]
    #[case::test_v_quoted("test -v \"{{ x }}\"", FillRefusal::NameWord)]
    #[case::wait_p("wait -p {{ x }}", FillRefusal::NameWord)]
    #[case::wait_p_quoted("wait -p \"{{ x }}\"", FillRefusal::NameWord)]
    #[case::declare_n("declare -n r={{ x }}", FillRefusal::NameWord)]
    #[case::declare_n_quoted("declare -n r=\"{{ x }}\"", FillRefusal::NameWord)]
    #[case::declare_array("declare -a \"a=({{ x }})\"", FillRefusal::NameWord)]
    #[case::declare_array_value("declare -a a=\"({{ x }})\"", FillRefusal::NameWord)]
    #[case::an_array_index("a=([{{ x }}]=v)", FillRefusal::ArraySubscript)]
    #[case::an_array_index_quoted("a=([\"{{ x }}\"]=v)", FillRefusal::ArraySubscript)]
    #[case::an_appended_array_index("a+=([{{ x }}]=v)", FillRefusal::ArraySubscript)]
    #[case::a_declared_array_index("declare -a a=([{{ x }}]=v)", FillRefusal::ArraySubscript)]
    #[case::a_declared_array_index_in_a_quoted_value(
        "declare -a a=\"([{{ x }}]=v)\"",
        FillRefusal::NameWord
    )]
    #[case::a_declared_array_index_in_a_quoted_word(
        "declare -a \"a=([{{ x }}]=v)\"",
        FillRefusal::NameWord
    )]
    #[case::let_through_builtin("builtin let {{ x }}", FillRefusal::Arithmetic)]
    #[case::read_through_command("command read {{ x }}", FillRefusal::NameWord)]
    #[case::printf_v_through_builtin("builtin printf -v {{ x }} a", FillRefusal::NameWord)]
    #[case::read_escaped("\\read {{ x }}", FillRefusal::NameWord)]
    #[case::read_quoted_name("\"read\" {{ x }}", FillRefusal::NameWord)]
    #[case::unset_through_builtin("builtin unset {{ x }}", FillRefusal::NameWord)]
    #[case::declare_through_builtin("builtin declare -n r={{ x }}", FillRefusal::NameWord)]
    fn a_save_refuses_a_fill_by_the_rule_of_its_place(
        #[case] line: &str,
        #[case] refusal: FillRefusal,
    ) {
        assert_eq!(save(line, LIMIT), vec![Err(refusal)]);
    }

    // A line past the reader's limit is read by none of the readings, so every fill is refused.
    #[test]
    fn a_save_refuses_every_fill_on_a_line_past_the_limit() {
        assert_eq!(
            save("echo {{ x }} {{ y }}", 4),
            vec![Err(FillRefusal::NotWhole), Err(FillRefusal::NotWhole)]
        );
    }

    // Each shell's reference for a bare word and for a string's text, read from the line the
    // template wrote, never from a placeholder.
    #[rstest]
    #[case::posix("bash", "echo \"${SIDEKICKS_VALUE_1}\" \"a ${SIDEKICKS_VALUE_2}\"")]
    #[case::powershell(
        "pwsh",
        "echo \"${env:SIDEKICKS_VALUE_1}\" \"a ${env:SIDEKICKS_VALUE_2}\""
    )]
    #[case::fish("fish", "echo \"$SIDEKICKS_VALUE_1\" \"a \"$SIDEKICKS_VALUE_2\"\"")]
    #[case::cmd("cmd", "echo \"!SIDEKICKS_VALUE_1!\" \"a !SIDEKICKS_VALUE_2!\"")]
    #[case::csh("tcsh", "echo \"${SIDEKICKS_VALUE_1:q}\" \"a ${SIDEKICKS_VALUE_2:q}\"")]
    fn a_launch_writes_each_shells_reference_for_its_place(
        #[case] program: &str,
        #[case] filled: &str,
    ) {
        assert_eq!(
            launch("echo {{ x }} \"a {{ y }}\"", grammar(program)),
            Ok(filled.to_owned())
        );
    }

    // The places whose form is not their outermost quote's: PowerShell calls a command name through
    // `&` once, a token a fill starts and the text goes on past is one PowerShell string, a pattern
    // word and a substitution are contexts of their own, and PowerShell reads a parameter's `"…"`
    // as a string.
    #[rstest]
    #[case::a_powershell_command_name(
        "{{ x }} --flag",
        "pwsh",
        "& \"${env:SIDEKICKS_VALUE_1}\" --flag"
    )]
    #[case::a_powershell_command_name_after_its_call_operator(
        "& {{ x }} --flag",
        "pwsh",
        "& \"${env:SIDEKICKS_VALUE_1}\" --flag"
    )]
    #[case::a_powershell_token_going_on_past_its_fill(
        "cp {{ x }}.bak d",
        "pwsh",
        "cp \"${env:SIDEKICKS_VALUE_1}.bak\" d"
    )]
    #[case::a_powershell_token_going_on_past_a_dash(
        "cp {{ x }}-old d",
        "pwsh",
        "cp \"${env:SIDEKICKS_VALUE_1}-old\" d"
    )]
    #[case::a_second_fill_in_a_powershell_token_string(
        "cp {{ x }}.{{ y }} d",
        "pwsh",
        "cp \"${env:SIDEKICKS_VALUE_1}.${env:SIDEKICKS_VALUE_2}\" d"
    )]
    #[case::a_pattern_word_in_a_string(
        "echo \"${p#{{ x }}}\"",
        "bash",
        "echo \"${p#\"${SIDEKICKS_VALUE_1}\"}\""
    )]
    #[case::a_parameter_string(
        "git --opt=\"{{ x }}\"",
        "pwsh",
        "git --opt=\"${env:SIDEKICKS_VALUE_1}\""
    )]
    #[case::a_substitution_in_a_string(
        "echo \"$(echo {{ x }})\"",
        "bash",
        "echo \"$(echo \"${SIDEKICKS_VALUE_1}\")\""
    )]
    #[case::after_a_quoted_here_document(
        "cat <<E'O'F\nbody\nEOF\necho {{ x }}",
        "bash",
        "cat <<E'O'F\nbody\nEOF\necho \"${SIDEKICKS_VALUE_1}\""
    )]
    fn a_launch_takes_the_nearest_contexts_form(
        #[case] line: &str,
        #[case] program: &str,
        #[case] filled: &str,
    ) {
        assert_eq!(launch(line, grammar(program)), Ok(filled.to_owned()));
    }

    // cmd.exe's delayed expansion reads again each piece of a command holding a `!`, the arguments
    // as one piece, so a launch escapes the author's `^` and `!` there, inside quotes and out, and
    // leaves a name running through a `/`, a redirection's target and another command without a
    // `!` as written.
    #[rstest]
    #[case::a_caret_in_a_string("grep \"^{{ x }}\" file", "grep \"^^!SIDEKICKS_VALUE_1!\" file")]
    #[case::a_caret_before_text_in_a_string(
        "grep \"^a {{ x }}\" file",
        "grep \"^^a !SIDEKICKS_VALUE_1!\" file"
    )]
    #[case::an_escaped_caret("echo ^^{{ x }}", "echo ^^^^\"!SIDEKICKS_VALUE_1!\"")]
    #[case::an_escaped_caret_in_a_name_running_through_a_slash(
        "echo/^^ {{ x }}",
        "echo/^^ \"!SIDEKICKS_VALUE_1!\""
    )]
    #[case::an_exclamation_mark("echo \"a!\" {{ x }}", "echo \"a^!\" \"!SIDEKICKS_VALUE_1!\"")]
    #[case::a_redirections_target(
        "grep \"^a\" {{ x }} > \"^b\"",
        "grep \"^^a\" \"!SIDEKICKS_VALUE_1!\" > \"^b\""
    )]
    #[case::another_command(
        "echo \"^a\" & echo {{ x }}",
        "echo \"^a\" & echo \"!SIDEKICKS_VALUE_1!\""
    )]
    fn a_cmd_launch_keeps_the_written_text_through_delayed_expansion(
        #[case] line: &str,
        #[case] filled: &str,
    ) {
        assert_eq!(launch(line, ShellGrammar::Cmd), Ok(filled.to_owned()));
    }

    // In a piece delayed expansion reads again, a `%NAME%` the launch's environment defines is
    // written `!NAME!`, so its value keeps its `^` and `!`; an undefined one stays as written, and
    // the first reading goes on from after its first `%`, so a defined name can start at its
    // second. A redirection's target without a `!` keeps a defined name as written.
    #[rstest]
    #[case::a_defined_name(
        "copy {{ x }} \"%TARGET%\"",
        "copy \"!SIDEKICKS_VALUE_1!\" \"!TARGET!\""
    )]
    #[case::an_undefined_name(
        "copy {{ x }} \"%SOURCE%\"",
        "copy \"!SIDEKICKS_VALUE_1!\" \"%SOURCE%\""
    )]
    #[case::a_defined_name_after_an_undefined_one(
        "copy {{ x }} %SOURCE%TARGET%",
        "copy \"!SIDEKICKS_VALUE_1!\" %SOURCE!TARGET!"
    )]
    #[case::a_target_not_read_again(
        "copy {{ x }} b > \"%TARGET%\"",
        "copy \"!SIDEKICKS_VALUE_1!\" b > \"%TARGET%\""
    )]
    fn a_cmd_launch_hands_a_defined_variable_over_unscanned(
        #[case] line: &str,
        #[case] filled: &str,
    ) {
        let is_defined = |name: &str| name.eq_ignore_ascii_case("target");
        let mut reader = ShellLineReader::new(LIMIT);
        assert_eq!(
            fills_of(line).fill_for_launch(&mut reader, ShellGrammar::Cmd, &is_defined),
            Ok(filled.to_owned())
        );
    }

    // The places a launch refuses with the rule that names them: a quote inside a substitution
    // inside a string, a here-document's quoted body as each requoted start reads, a body line that
    // begins with the delimiter, and csh's body, backquotes and comment.
    #[rstest]
    #[case::single_quotes_in_a_substitution(
        "echo \"$(echo '{{ x }}')\"",
        "bash",
        FillRefusal::NotExpanding
    )]
    // The bash reading's own refusals, which the PowerShell reading would also give at save: a
    // string left open, bash 5.3's command forms of `${…}`, which the grammar reads whole only
    // when the fill opens the body, and an offset written as a bare fill.
    #[case::a_syntax_error("echo \"{{ x }}", "bash", FillRefusal::NotWhole)]
    #[case::a_command_in_an_expansion("echo ${ echo {{ x }}; }", "bash", FillRefusal::NotWhole)]
    #[case::a_value_command_in_an_expansion(
        "echo ${| echo {{ x }}; }",
        "bash",
        FillRefusal::NotWhole
    )]
    #[case::a_fill_opening_a_command_in_an_expansion(
        "echo ${ {{ x }}}",
        "bash",
        FillRefusal::CommandInExpansion
    )]
    #[case::a_bare_offset("echo ${p:{{ x }}}", "bash", FillRefusal::Arithmetic)]
    #[case::a_bare_offset_quoted("echo \"${p:{{ x }}}\"", "bash", FillRefusal::Arithmetic)]
    #[case::a_cmd_escape("echo ^{{ x }}", "cmd", FillRefusal::CmdCaret)]
    #[case::a_body_after_a_partly_quoted_start(
        "cat <<E'O'F\n{{ x }}\nEOF",
        "bash",
        FillRefusal::NotExpanding
    )]
    #[case::a_body_after_a_quoted_head(
        "cat <<'E'OF\n{{ x }}\nEOF",
        "bash",
        FillRefusal::NotExpanding
    )]
    #[case::a_body_after_an_escaped_start(
        "cat <<E\\OF\n{{ x }}\nEOF",
        "bash",
        FillRefusal::NotExpanding
    )]
    #[case::a_body_line_beginning_with_the_delimiter(
        "cat <<'EOF'\nEOFX\nEOF\necho {{ x }}",
        "bash",
        FillRefusal::HereDocumentEnd { delimiter: "EOF".to_owned() }
    )]
    #[case::a_csh_here_document(
        "cat <<EOF\n{{ x }}\nEOF",
        "tcsh",
        FillRefusal::CshHereDocumentBody
    )]
    #[case::csh_backquotes("echo `echo {{ x }}`", "tcsh", FillRefusal::Backquoted)]
    #[case::a_csh_comment("echo a # {{ x }}", "tcsh", FillRefusal::Comment)]
    fn a_launch_refuses_a_fill_by_the_rule_of_its_place(
        #[case] line: &str,
        #[case] program: &str,
        #[case] refusal: FillRefusal,
    ) {
        assert_eq!(
            launch(line, grammar(program)),
            Err(RefusedFill { number: 1, refusal })
        );
    }

    // The start forms the requote skips, whose body is refused through the end-line check or the
    // parse, for whichever rule the reading finds first.
    #[rstest]
    #[case::ansi_c_start("cat <<$'EOF'\n{{ x }}\nEOF")]
    #[case::translated_start("cat <<$\"EOF\"\n{{ x }}\nEOF")]
    #[case::empty_start("cat <<''\n{{ x }}\n")]
    fn a_launch_refuses_a_body_after_a_start_the_requote_skips(#[case] line: &str) {
        assert!(launch(line, grammar("bash")).is_err());
    }

    // A listed shell's program name, as a path, with `.exe` and in any case, picks its grammar; any
    // other program picks none, so no line runs under a guessed shell.
    #[rstest]
    #[case::bash("bash", Some("posix"))]
    #[case::bash_exe("bash.exe", Some("posix"))]
    #[case::pwsh_path("/usr/bin/pwsh", Some("powershell"))]
    #[case::powershell_exe("powershell.exe", Some("powershell"))]
    #[case::cmd_upper_case("CMD.EXE", Some("cmd"))]
    #[case::fish("fish", Some("fish"))]
    #[case::tcsh("tcsh", Some("csh"))]
    #[case::nu("nu", None)]
    #[case::xonsh("xonsh", None)]
    #[case::env("env", None)]
    fn a_program_path_picks_its_shells_grammar(#[case] program: &str, #[case] arm: Option<&str>) {
        let found = shell_grammar_for_program(Path::new(program)).map(|grammar| match grammar {
            ShellGrammar::Posix(_) => "posix",
            ShellGrammar::PowerShell => "powershell",
            ShellGrammar::Cmd => "cmd",
            ShellGrammar::Fish => "fish",
            ShellGrammar::Csh => "csh",
        });
        assert_eq!(found, arm);
    }
}
