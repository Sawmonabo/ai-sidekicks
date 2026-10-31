use rstest::rstest;
use sidekicks_contracts::approval::RememberedScopeKind;

use super::*;

// Far past every line here, so the cases read the walk and never the cap.
const LIMIT: usize = 4096;

#[rstest]
// The shell's own grammar: chains, pipes, groups, loops, conditions, functions and
// substitutions; a line not read whole by the words its scan shows, quoted text one word, a
// listed shell's string read again and an interpreter's code not read.
#[case::force_push("git push --force", true)]
#[case::plain_push("git push origin main", false)]
#[case::folder_option_value("git -C dir push --force", true)]
#[case::folder_option_takes_push("git -C push -f", false)]
#[case::forcing_refspec("git push origin +main", true)]
#[case::deleting_refspec("git push origin :main", true)]
#[case::lease_with_value("git push --force-with-lease=x", true)]
#[case::branch_delete("git branch -D x", true)]
#[case::push_cluster("git push -qf", true)]
#[case::dry_run("git push --dry-run origin main", false)]
#[case::branch_long_option_with_d("git branch --edit-description", false)]
#[case::chain("git fetch && git push --force", true)]
#[case::list("cd x; git push -f", true)]
#[case::pipeline("echo x | git push --force", true)]
#[case::subshell("( git push --force )", true)]
#[case::group("{ git push --force; }", true)]
#[case::group_of_a_plain_push("{ git push origin main; }", false)]
#[case::for_loop("for b in a; do git push --force; done", true)]
#[case::condition("if true; then git branch -D x; fi", true)]
#[case::function("f() { git push --force; }; f", true)]
#[case::substitution(r#"echo "$(git push --force)""#, true)]
#[case::other_program("cargo test", false)]
#[case::unterminated_line(r#"git push --force origin main && echo "unterminated"#, true)]
#[case::one_command_not_read_whole(r#"git push origin main "unterminated"#, false)]
#[case::zsh_short_loop("for x in 1; git push --force", true)]
#[case::zsh_short_loop_of_a_reading_command("for x in 1; git status", false)]
#[case::zsh_short_loop_with_a_comment("for x in 1; git push origin # --force", false)]
#[case::zsh_short_loop_of_an_equals_name("for x in 1; =git push --force", true)]
#[case::zsh_short_loop_of_an_ansi_c_name("for x in 1; $'git' push --force", true)]
#[case::zsh_short_loop_of_a_split_string("for x in 1; env -S'git push --force'", true)]
#[case::zsh_short_loop_of_a_quoted_argument(r#"for x in 1; echo "git push --force""#, false)]
#[case::zsh_short_loop_of_a_shell_string("for x in 1; sh -c 'git push --force'", true)]
#[case::zsh_short_loop_of_an_interpreter(
    r#"for x in 1; awk 'BEGIN { system("git push --force") }'"#,
    false
)]
#[case::zsh_short_loop_of_a_git_setting("for x in 1; GIT_PAGER='git push --force' git log", false)]
// A brace word with a comma or a sequence spells its alternatives, any of which may be the
// subcommand or an option of a push, and an ANSI-C string the shells decode apart counts too;
// `{}` and `{x}` are text, and a word only the run decides, a parameter, a substitution or a
// pattern, is none of them.
#[case::brace_alternatives_of_a_push("git push {--force,origin}", true)]
#[case::brace_alternatives_of_one_option("git push --{force,force}", true)]
#[case::brace_alternatives_of_a_folder("git -C {.,push} --force", true)]
#[case::brace_alternatives_of_a_refspec("git push origin {a,b}", true)]
#[case::brace_sequence_of_a_refspec("git push origin {1..2}", true)]
#[case::empty_braces("git push origin {}", false)]
#[case::braces_of_one_word("git push origin {main}", false)]
#[case::unknown_ansi_c_escape(r"git $'\push' --force", true)]
#[case::ansi_c_subcommand("git $'push' --force", true)]
#[case::pattern_of_an_option("git push --forc?", false)]
#[case::expanded_subcommand("X=push; git $X -f", false)]
#[case::braced_expansion_subcommand("git ${X} --force", false)]
#[case::expansion_after_a_reading_subcommand("git log --since=$DATE", false)]
#[case::expanded_option_word("git -$X --force", false)]
#[case::expanded_option_word_after_its_value(r#"X="C . push"; git -$X --force"#, false)]
#[case::quoted_folder_value(r#"git -C "$D" log"#, false)]
#[case::expanded_refspec(r#"git push origin "$BRANCH""#, false)]
#[case::expanded_branch_name(r#"git branch "$NEW""#, false)]
#[case::expanded_program("G=git; $G push --force", false)]
#[case::undecided_operand_of_a_wrapper(r#"timeout "$T" cargo test"#, false)]
#[case::quoted_expanded_program(r#""$TOOL" build"#, false)]
#[case::undecided_lookup_option("command -$v git push --force", true)]
// The wrappers' commands, read past their own options, values and operands.
#[case::timeout_duration("timeout 30 git push --force", true)]
#[case::gnu_timeout("gtimeout 5 git push --force", true)]
#[case::time_keyword("time git push -f", true)]
#[case::nice_adjustment("nice -n 5 git push --force", true)]
#[case::nohup_in_the_background("nohup git push --force &", true)]
#[case::buffering_wrapper("stdbuf -oL git push --force", true)]
#[case::lookup_through_a_wrapper("command -v node", false)]
#[case::builtin_eval("builtin eval 'git push --force'", true)]
#[case::noglob_modifier("noglob git push --force", true)]
#[case::nocorrect_modifier("nocorrect git push --force", true)]
#[case::equals_expansion("=git push --force", true)]
#[case::dash_modifier("true; - git push --force", true)]
#[case::exec_wrapper("exec git push --force", true)]
#[case::search_path_value("env -P /usr/bin git push --force", true)]
#[case::prefix_of_a_value_option("env --chd /tmp git push --force", true)]
#[case::lone_dash_of_env("env - git push --force", true)]
#[case::value_letter_ending_a_cluster("sudo -Eu root git push --force", true)]
#[case::value_inside_the_cluster("sudo -uroot git push --force", true)]
#[case::value_after_the_long_option("sudo --user=root git push --force", true)]
#[case::prefix_of_a_sudo_option("sudo --us root git push --force", true)]
#[case::sudo_login("sudo --login git push --force", true)]
#[case::sudo_login_class("sudo --login-class X git push --force", true)]
#[case::doas_wrapper("doas git push --force", true)]
#[case::affinity_mask_before_the_command("taskset 0x1 git push --force", true)]
#[case::policy_with_no_priority("chrt -o git push --force", true)]
#[case::undecided_priority("chrt $P git push --force", true)]
#[case::architecture_option("arch -arm64e git push --force", true)]
#[case::sleep_assertion_wrapper("caffeinate git push --force", true)]
#[case::repeat_count("repeat 1 git push --force", true)]
#[case::repeat_list("repeat 1 { git push --force }", true)]
#[case::chroot_command("chroot / git push --force", true)]
#[case::sandbox_command("sandbox-exec -p '(version 1)(allow default)' git push --force", true)]
#[case::script_command("script -q /dev/null git push --force", true)]
#[case::script_line("script -c 'git push --force' /dev/null", true)]
// xargs's and zargs's commands are read; the words xargs reads from its input and zargs's
// input list are not.
#[case::xargs_command("xargs git push --force", true)]
#[case::xargs_replacement_value("xargs -J % git push --force", true)]
#[case::xargs_attached_optional_value("xargs -iI git push --force", true)]
#[case::xargs_after_a_pipe("find . -print0 | xargs -0 git push --force", true)]
#[case::xargs_shell_string("xargs sh -c 'git push --force'", true)]
#[case::xargs_input_words("echo --force | xargs git push origin main", false)]
#[case::xargs_replaced_argument("echo --force | xargs -I% git push origin %", false)]
#[case::xargs_replaced_shell_string("echo 'git push -f' | xargs -I% sh -c %", false)]
#[case::xargs_appended_shell_string("echo 'git push -f' | xargs sh -c", false)]
#[case::xargs_reading_subcommand("echo x | xargs git status", false)]
#[case::xargs_reading_command("xargs -0 git log", false)]
#[case::xargs_input_to_a_sudo_shell("echo 'git push --force' | xargs sudo -s", false)]
#[case::xargs_input_to_a_wrapper("echo 'git push --force' | xargs nohup", false)]
#[case::zargs_command("zargs -- x -- git push --force", true)]
#[case::zargs_input_list("zargs -- --force -- git push origin", false)]
// env's split string, read as env's own words and capped at the line's length.
#[case::split_string_inside_the_word("env -S'git push --force'", true)]
#[case::split_string_in_a_cluster("env -vS'git push --force'", true)]
#[case::split_string_after_the_long_option("env --split-string='git push --force'", true)]
#[case::prefix_of_the_split_option("env --sp='git push --force'", true)]
#[case::option_inside_a_split_string("env -S'-i git push --force'", true)]
#[case::quotes_inside_a_split_string(r#"env -S'git "push" --force'"#, true)]
#[case::separator_escape_inside_a_split_string(r"env -S'git\_push\_--force'", true)]
#[case::expansion_after_the_program("env -S'git push --force ${X}'", true)]
#[case::quoted_parameter_inside_a_split_string(r#"X=". push"; env -S"git -C $X --force""#, false)]
#[case::nested_split_past_the_line(r#"env -S'-S "git push --force"'"#, true)]
#[case::nested_split_chain("env -S-S-S-Sgit push --force", true)]
#[case::line_break_in_a_split_string("env -S'A=1\ngit push --force'", true)]
#[case::vertical_tab_in_a_split_string("env -S'git\u{b}push\u{b}--force'", true)]
#[case::git_environment_alias_through_env(
    "env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.p GIT_CONFIG_VALUE_0=push git p --force",
    true
)]
// The listed shells' lines, each by its own grammar, and the lines the listed programs hand
// a shell.
#[case::shell_string("sh -c 'git push -f'", true)]
#[case::login_shell_string("bash -lc 'git push --force'", true)]
#[case::shell_named_by_its_folder("/bin/zsh -lc 'git push --force'", true)]
#[case::dash_string("dash -c 'git push --force'", true)]
#[case::ksh_value_before_the_command_string("ksh -R f -c 'git push --force'", true)]
#[case::fish_string("fish -c 'git push --force'", true)]
#[case::tcsh_string("tcsh -c 'git push --force'", true)]
#[case::csh_string("csh -c 'git push --force'", true)]
#[case::option_letter_in_the_string_cluster("bash -co posix 'git push --force'", true)]
#[case::zsh_emulation_value("zsh --emulate sh -c 'git push --force'", true)]
#[case::cmd_line("cmd /c git push --force", true)]
#[case::cmd_exe_line("cmd.exe /k git push --force", true)]
#[case::powershell_command("pwsh -Command 'git push --force'", true)]
#[case::powershell_short_command("powershell -c 'git push --force'", true)]
#[case::powershell_file("pwsh -File x.ps1", false)]
#[case::powershell_encoded_command("pwsh -EncodedCommand ZwBpAHQA", false)]
#[case::shell_string_of_a_parameter(r#"sh -c "$CMD""#, false)]
#[case::nested_shell_string(r#"sh -c 'sh -c "git push --force"'"#, true)]
#[case::shell_string_of_other_work("sh -c 'cargo test'", false)]
#[case::force_push_in_a_shell_string("bash -c 'git push --force origin main'", true)]
#[case::eval_string(r#"eval "git push --force""#, true)]
#[case::trap_line("trap 'git push --force' EXIT", true)]
#[case::alias_value("alias g='git push --force'", true)]
#[case::alias_used("shopt -s expand_aliases\nalias g='git push --force'\ng", true)]
#[case::emulate_line("emulate sh -c 'git push --force'", true)]
#[case::emulate_option_after_the_line_option("emulate sh -c -x 'git push --force'", true)]
#[case::emulate_options_ended("emulate sh -c -- 'git push --force'", true)]
#[case::completion_line("compgen -C 'git push --force' x", true)]
#[case::mapfile_line("mapfile -tC 'git push --force' -c 1 <<< x", true)]
#[case::readarray_attached_line("readarray -c1 -C'git push --force' <<< x", true)]
#[case::su_command_string("su -c 'git push --force'", true)]
#[case::su_command_after_the_long_option("su --command='git push --force'", true)]
#[case::shell_string_after_the_user("su root -sc 'git push --force'", true)]
#[case::watch_words("watch -n 1 'git push' --force", true)]
#[case::flock_command("flock f git push --force", true)]
#[case::flock_line("flock f -c 'git push --force'", true)]
#[case::flock_descriptor("flock --fd 3 git push --force", true)]
#[case::setsid_command("setsid git push --force", true)]
#[case::ionice_class("ionice -c 3 git push --force", true)]
// A here-document or here-string on a listed shell's own statement is its line when it reads
// its input; a pipe, a file, another descriptor and every other operand are not read.
#[case::here_string_to_a_shell("sh <<< 'git push --force'", true)]
#[case::here_document_to_a_shell("sh <<E\ngit push --force\nE", true)]
#[case::here_document_of_other_work("bash <<'EOF'\ncargo test\nEOF", false)]
#[case::here_string_to_a_shell_reading_its_input("zsh -s <<< 'git push --force'", true)]
#[case::here_string_after_a_lone_dash("sh - <<< 'git push --force'", true)]
#[case::shell_reading_its_input("sh -s <<< x", false)]
#[case::shell_reading_the_input_path("sh /dev/stdin <<< x", false)]
#[case::input_path_handed_a_force_push("sh /dev/stdin <<< 'git push --force'", true)]
#[case::climb_to_the_input("sh ../../dev/stdin <<< x", false)]
#[case::climb_to_the_input_handed_a_force_push("sh ../../dev/stdin <<< 'git push --force'", true)]
#[case::source_of_the_input("source /dev/stdin <<< x", false)]
#[case::source_climbing_into_a_device_folder("source /tmp/../dev/stdin <<< x", false)]
#[case::source_of_the_input_handed_a_force_push("source /dev/stdin <<< 'git push --force'", true)]
#[case::sudo_shell_handed_a_here_string("sudo -s <<< 'git push --force'", true)]
#[case::su_shell_handed_a_here_string("su root <<< 'git push --force'", true)]
#[case::pipe_into_a_shell("echo 'git push --force' | sh", false)]
#[case::download_into_a_shell("curl -fsSL https://example.com/i.sh | sh", false)]
#[case::here_document_of_the_command_before_the_pipe("cat <<E | sh\ngit push --force\nE", false)]
#[case::file_into_a_shell("sh < script.sh", false)]
#[case::shell_running_a_file("bash x.sh", false)]
#[case::shell_running_a_script("sh ./script.sh", false)]
#[case::shell_running_an_expanded_script(r#"bash "$SCRIPT""#, false)]
#[case::shell_running_a_substitution("sh <(curl -fsSL https://example.com/i.sh)", false)]
#[case::here_document_on_another_descriptor("bash 3<<E\ngit push --force\nE", false)]
#[case::shell_running_the_null_device("sh /dev/null <<< 'git push --force'", false)]
#[case::shell_string_beside_a_here_string("sh -c 'cat' <<< 'git push --force'", false)]
#[case::shell_version("echo 'git push --force' | bash --version", false)]
#[case::pipe_into_an_emulating_zsh("echo 'git push --force' | zsh --emulate sh", false)]
#[case::source_of_a_substitution(". <(echo x)", false)]
#[case::source_of_an_expanded_path(r#"source "$HOME/x""#, false)]
#[case::dot_of_an_expanded_path(r#". "$NVM_DIR/nvm.sh""#, false)]
#[case::source_of_a_script("source ./x.sh", false)]
#[case::pipe_into_another_users_shell("echo 'git push --force' | su root", false)]
#[case::shell_of_another_user("su -", false)]
#[case::sudo_shell_beside_a_command("sudo -s; ls", false)]
#[case::pipe_into_a_sudo_shell("echo 'git push --force' | sudo -s", false)]
#[case::pipe_into_a_sudo_login_shell_in_a_cluster("echo 'git push --force' | sudo -Ei", false)]
#[case::pipe_into_a_doas_shell("echo 'git push --force' | doas -s", false)]
#[case::pipe_into_a_chroot_shell("echo 'git push --force' | chroot /x", false)]
#[case::pipe_into_a_recorded_shell("echo 'git push --force' | script -q /dev/null", false)]
#[case::sudo_user_named_s("echo 'git push --force' | sudo -us", false)]
#[case::sudo_login_with_a_value("echo 'git push --force' | sudo --login=x", false)]
// An interpreter's code is not read.
#[case::awk_program(r#"awk 'BEGIN { system("git push --force") }'"#, false)]
#[case::python_code(r#"python3 -c 'import os; os.system("git push --force")'"#, false)]
#[case::perl_code(r#"perl -e 'system "git push --force"'"#, false)]
#[case::ruby_code(r#"ruby -e 'system("git push --force")'"#, false)]
#[case::node_code(
    r#"node -e "require('child_process').execSync('git push --force')""#,
    false
)]
#[case::osascript_code(r#"osascript -e 'do shell script "git push --force"'"#, false)]
#[case::python_script("python3 manage.py test", false)]
#[case::node_version("node --version", false)]
#[case::bun_script("bun run build", false)]
#[case::deno_eval("deno eval 'console.log(1)'", false)]
#[case::interpreter_through_a_wrapper("timeout 5 python3 -c 'print(1)'", false)]
#[case::interpreter_in_a_shell_string(r#"sh -c 'python3 -c "import os"'"#, false)]
#[case::force_push_beside_an_interpreter("git push --force; python3 x.py", true)]
// find's command primaries run their commands, `{}` a path the run decides.
#[case::find_exec(r"find . -exec git push --force \;", true)]
#[case::find_okdir_after_its_path("find . -okdir git push --force {} +", true)]
#[case::find_execdir_shell_string(r"find . -execdir sh -c 'git push --force' \;", true)]
#[case::find_exec_of_a_reading_command(r"find . -exec git status \;", false)]
#[case::find_exec_of_a_found_path(r"find . -exec git push {} \;", false)]
#[case::find_delete("find . -delete", false)]
#[case::find_file_print("find . -fprint out.txt", false)]
#[case::find_with_no_action("find . -name '*.rs'", false)]
// git's own forms: aliases and the settings whose value git hands a shell, through `-c`, the
// environment and its parameters; no other setting or option is read.
#[case::git_alias_line("git -c alias.x='!git push --force' x", true)]
#[case::git_alias_words("git -c alias.x='push --force' x", true)]
#[case::git_alias_before_its_words("git -c alias.p=push p --force", true)]
#[case::git_alias_of_a_reading_subcommand("git -c alias.l=log l --force", false)]
#[case::git_environment_alias_line(
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.x GIT_CONFIG_VALUE_0='!git push --force' git x",
    true
)]
#[case::git_pager_setting("git -c core.pager='git push --force' log", true)]
#[case::git_pager_environment("GIT_PAGER='git push --force' git log", true)]
#[case::git_credential_helper_line("git -c credential.helper='!git push --force' fetch", true)]
#[case::git_credential_helper_of_a_site(
    "git -c credential.https://example.com.helper='!git push --force' fetch",
    true
)]
#[case::git_parameters_alias(r#"GIT_CONFIG_PARAMETERS="'alias.x'='push --force'" git x"#, true)]
#[case::git_parameters_pager(r#"GIT_CONFIG_PARAMETERS="'core.pager=git push -f'" git log"#, true)]
#[case::git_editor_setting("git -c core.editor='git push --force' commit", true)]
#[case::git_sequence_editor_setting(
    "git -c sequence.editor='git push --force' rebase -i HEAD~2",
    true
)]
#[case::git_ssh_command_setting("git -c core.sshCommand='git push --force' fetch", true)]
#[case::git_external_diff_setting("git -c diff.external='git push --force' diff", true)]
#[case::git_editor_environment("GIT_EDITOR='git push --force' git commit", true)]
#[case::git_sequence_editor_environment(
    "GIT_SEQUENCE_EDITOR='git push --force' git rebase -i HEAD~2",
    true
)]
#[case::git_ssh_command_environment("GIT_SSH_COMMAND='git push --force' git fetch", true)]
#[case::git_external_diff_environment("GIT_EXTERNAL_DIFF='git push --force' git diff", true)]
#[case::git_hooks_folder("git -c core.hooksPath='git push --force' status", false)]
#[case::git_include_path("git -c include.path=x status", false)]
#[case::git_pager_of_one_subcommand("git -c pager.log='git push --force' log", false)]
#[case::pager_environment("PAGER='git push --force' git log", false)]
#[case::editor_environment("EDITOR='git push --force' git commit --allow-empty", false)]
#[case::visual_environment("VISUAL='git push --force' git commit", false)]
#[case::credential_helper_without_a_bang(
    "git -c credential.helper='x; git push --force' credential fill",
    false
)]
#[case::trailer_command(
    "git -c trailer.sign.cmd='git push --force' interpret-trailers --trailer sign=x",
    false
)]
#[case::config_from_the_environment("A='!git push --force' git --config-env=alias.x=A x", false)]
#[case::alias_set_before_its_use("git config alias.x '!git push --force' && git x", false)]
#[case::git_editor_for_a_shell_string(
    "GIT_EDITOR='git push --force' sh -c 'git commit --allow-empty'",
    false
)]
#[case::git_environment_alias_for_a_shell_string(
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.x \
     GIT_CONFIG_VALUE_0='!git push --force' bash -c 'git x'",
    false
)]
#[case::exported_git_parameters_for_a_shell_string(
    r#"export GIT_CONFIG_PARAMETERS="'alias.x=!git push --force'"; sh -c 'git x'"#,
    false
)]
#[case::rebase_exec("git rebase -x 'git push --force' HEAD~1", false)]
#[case::upload_pack_program("git ls-remote --upload-pack='git push --force;' .", false)]
#[case::grep_pager("git grep -O'git push --force;' -e x", false)]
#[case::git_version("git --version", false)]
// A program off the list is plain words.
#[case::program_finder("xcrun git push --force", false)]
#[case::manual_pager("man -P 'git push --force' ls", false)]
#[case::file_finder_exec("fd -x git push --force", false)]
#[case::environment_runner("devbox run git push --force", false)]
#[case::container_exec("docker exec c git push --force", false)]
#[case::file_remover("rm -rf build", false)]
#[case::npm_script("npm run build", false)]
#[case::pnpm_script("pnpm run lint", false)]
#[case::yarn_script("yarn run test", false)]
#[case::runner_alone("npm run", false)]
#[case::npm_subcommand("npm test", false)]
// git reads a long option of a push or a branch by any prefix of its name, and a program named by
// a path as the program its last segment names. Killed by push's or branch's options read only
// by their whole names, and by a path's folder left on the program the list matches.
#[case::push_delete_by_prefix("git push --dele origin main", true)]
#[case::push_mirror_by_prefix("git push --mirr origin", true)]
#[case::branch_delete_by_prefix("git branch --dele x", true)]
#[case::git_named_by_a_relative_path("./git push --force", true)]
#[case::git_named_by_an_absolute_path("/usr/bin/git push --force", true)]
// A here-string on xargs's statement is xargs's own input, the words it appends, never the line
// of the shell it runs; a here-string a `<` file redirect follows stays the shell's line, as zsh
// feeds it both. Killed by the shell xargs runs handed the here-string, and by a later file
// redirect clearing it.
#[case::here_string_into_xargs("xargs sh <<< 'git push --force'", false)]
#[case::here_string_before_a_file_redirect("sh <<< 'git push --force' < f", true)]
fn a_line_reads_destructive_git(#[case] line: &str, #[case] is_destructive: bool) {
    let mut reader = ShellLineReader::new(LIMIT);
    let reading = reader.read(line);

    assert_eq!(runs_destructive_git(&mut reader, &reading), is_destructive);
}

#[rstest]
#[case::git_alone(
    RememberedRuleSense::Allow,
    ProviderAskActionKind::Command,
    "git",
    true
)]
#[case::git_push(
    RememberedRuleSense::Allow,
    ProviderAskActionKind::Command,
    "git push",
    true
)]
#[case::git_branch(
    RememberedRuleSense::Allow,
    ProviderAskActionKind::Command,
    "git branch",
    true
)]
#[case::push_with_remote(
    RememberedRuleSense::Allow,
    ProviderAskActionKind::Command,
    "git push origin",
    false
)]
#[case::other_subcommand(
    RememberedRuleSense::Allow,
    ProviderAskActionKind::Command,
    "git status",
    false
)]
#[case::block(
    RememberedRuleSense::Block,
    ProviderAskActionKind::Command,
    "git push",
    false
)]
#[case::not_a_command(
    RememberedRuleSense::Allow,
    ProviderAskActionKind::FileChange,
    "git",
    false
)]
fn a_rule_covers_destructive_git(
    #[case] sense: RememberedRuleSense,
    #[case] action: ProviderAskActionKind,
    #[case] subject: &str,
    #[case] covers: bool,
) {
    let rule = ProviderAskRule {
        kind: RememberedScopeKind::Session,
        sense,
        action,
        subject: subject.to_owned(),
    };

    assert_eq!(covers_destructive_git(&rule), covers);
}
