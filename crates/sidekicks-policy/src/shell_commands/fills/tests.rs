use std::path::Path;

use rstest::rstest;
use sidekicks_contracts::workflow::definition::expression_template::{TemplateText, read_template};

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
    fills_of(line).fill_for_launch(&mut ShellLineReader::new(LIMIT), shell)
}

fn grammar(program: &str) -> ShellGrammar {
    shell_grammar_for_program(Path::new(program)).expect("each program here is a listed shell")
}

// Each place a save accepts: a word, a word joined to unquoted text, a substitution's word, a
// string's text, a substitution inside a string, and escaped quotes around a fill, which every
// reading takes as text beside a bare word.
#[rstest]
#[case::a_bare_word("echo {{ x }}")]
#[case::joined_to_an_option("echo --name={{ x }}")]
#[case::in_a_substitution("echo $(echo {{ x }})")]
#[case::in_a_string("echo \"a {{ x }}\"")]
#[case::in_a_substitution_in_a_string("echo \"$(echo {{ x }})\"")]
#[case::between_escaped_quotes("echo \\\"{{ x }}\\\"")]
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
#[case::a_syntax_error("echo \"{{ x }}", FillRefusal::NotWhole)]
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
#[case::a_subscript("echo ${a[{{ x }}]}", FillRefusal::Arithmetic)]
#[case::a_subscript_quoted("echo \"${a[{{ x }}]}\"", FillRefusal::Arithmetic)]
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
fn a_save_refuses_a_fill_by_the_rule_of_its_place(
    #[case] line: &str,
    #[case] refusal: FillRefusal,
) {
    assert_eq!(save(line, LIMIT), vec![Err(refusal)]);
}

// Places whose refusal rests on how the parser reads an unusual form: bash 5.3's command forms of
// `${…}`, and an offset written as a bare fill.
#[rstest]
#[case::a_command_in_an_expansion("echo ${ echo {{ x }}; }")]
#[case::a_value_command_in_an_expansion("echo ${| echo {{ x }}; }")]
#[case::a_bare_offset("echo ${p:{{ x }}}")]
#[case::a_bare_offset_quoted("echo \"${p:{{ x }}}\"")]
fn a_save_refuses_a_fill_in_a_form_no_reading_shows_expanding(#[case] line: &str) {
    assert!(save(line, LIMIT).iter().all(Result::is_err));
}

// A line past the reader's limit is read by none of the readings, so every fill is refused.
#[test]
fn a_save_refuses_every_fill_on_a_line_past_the_limit() {
    assert_eq!(
        save("echo {{ x }} {{ y }}", 4),
        vec![Err(FillRefusal::NotWhole), Err(FillRefusal::NotWhole)]
    );
}

// Each shell's reference for a bare word and for a string's text, read from the line the template
// wrote, never from a placeholder.
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
// `&`, a pattern word and a substitution are contexts of their own, and PowerShell reads a
// parameter's `"…"` as a string.
#[rstest]
#[case::a_powershell_command_name(
    "{{ x }} --flag",
    "pwsh",
    "& \"${env:SIDEKICKS_VALUE_1}\" --flag"
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

// The places a launch refuses with the rule that names them: a quote inside a substitution inside
// a string, a here-document's quoted body as each requoted start reads, a body line that begins
// with the delimiter, and csh's body, backquotes and comment.
#[rstest]
#[case::single_quotes_in_a_substitution(
    "echo \"$(echo '{{ x }}')\"",
    "bash",
    FillRefusal::NotExpanding
)]
#[case::a_body_after_a_partly_quoted_start(
    "cat <<E'O'F\n{{ x }}\nEOF",
    "bash",
    FillRefusal::NotExpanding
)]
#[case::a_body_after_a_quoted_head("cat <<'E'OF\n{{ x }}\nEOF", "bash", FillRefusal::NotExpanding)]
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
#[case::a_csh_here_document("cat <<EOF\n{{ x }}\nEOF", "tcsh", FillRefusal::CshHereDocumentBody)]
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
