#!/usr/bin/env python3
"""
claude-md-audit eval harness

Usage:
    eval_harness.py setup     [--iteration N] [--test ID]
    eval_harness.py run       [iteration] [--model MODEL] [--test ID]
    eval_harness.py grade     [iteration] [--model MODEL]
    eval_harness.py aggregate [iteration]
    eval_harness.py full      [iteration] [--model MODEL] [--test ID]
    eval_harness.py status    [iteration]

Options:
    --iteration N   Use specific iteration number (default: next available)
    --model MODEL   Model for claude -p (e.g. sonnet, opus, haiku)
    --test ID       Run only one test (e.g. m32rimm-real-world)

Examples:
    eval_harness.py full
    eval_harness.py full --model sonnet
    eval_harness.py run --test m32rimm-real-world --model opus
    eval_harness.py grade 6
    eval_harness.py status
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Literal, NoReturn, TextIO, TypedDict, cast

type RunVariant = Literal["with-skill", "baseline"]
type DisplayVariant = Literal["with-skill", "baseline", "unknown"]
type RunStatus = Literal["In-Progress", "Done", "Failed"]
type RunKey = tuple[str, RunVariant]
type GradeKey = tuple[str, DisplayVariant]


class BaseTestSpec(TypedDict):
    id: str
    prompt: str
    assertions: list[str]


class TestSpec(BaseTestSpec, total=False):
    fixture_path: str
    target_repo: str


class SuiteSpec(TypedDict):
    skill_path: str
    tests: list[TestSpec]


class SetupResult(TypedDict):
    iteration: int
    workspace: str
    tests: list[str]


class EvalMetadata(TypedDict):
    eval_id: int
    eval_name: str
    prompt: str
    target_repo: str
    assertions: list[str]


class TimingData(TypedDict, total=False):
    duration_ms: int
    total_duration_seconds: float
    total_tokens: int


class GradingResult(TypedDict, total=False):
    eval_name: str
    passed: int
    failed: int
    total: int
    pass_rate: float


class AggregateRow(TypedDict):
    name: str
    passed: int
    failed: int
    total: int
    pass_rate: float
    tokens: int
    duration_s: float


class AggregateSummary(TypedDict):
    total_assertions: int
    total_passed: int
    overall_pass_rate: float


class BenchmarkSummary(TypedDict):
    iteration: int
    results: list[AggregateRow]
    aggregate: AggregateSummary


@dataclass
class RunTask:
    test_id: str
    variant: RunVariant
    process: subprocess.Popen[bytes]
    start_time: float
    vdir: Path
    stdout_handle: TextIO
    stderr_handle: TextIO


@dataclass
class RunCell:
    status: RunStatus
    elapsed_s: float | None = None
    logged: bool = False


@dataclass(frozen=True)
class GradeTarget:
    vdir: Path
    test_id: str
    variant: DisplayVariant


POLL_INTERVAL: Final[int] = 5
COLUMN_WIDTH: Final[int] = 16
SPINNER: Final[tuple[str, str, str]] = (".", "..", "...")
RUN_VARIANTS: Final[tuple[RunVariant, RunVariant]] = (
    "with-skill",
    "baseline",
)
USAGE_TEXT: Final[str] = __doc__ or ""
GRADE_PENDING: Final[str] = "Pending"
GRADE_RUNNING: Final[str] = "Grading..."


def log(message: str = "", end: str = "\n") -> None:
    sys.stdout.write(f"{message}{end}")
    sys.stdout.flush()


def fail(message: str) -> NoReturn:
    log(message)
    raise SystemExit(1)


def show_usage() -> None:
    log(USAGE_TEXT, end="")


def find_git_root() -> Path:
    path = Path.cwd()
    while path != path.parent:
        if (path / ".git").exists():
            return path
        path = path.parent
    return Path.cwd()


ROOT = find_git_root()
WORKSPACE = ROOT / ".claude" / "tmp" / "sessions" / "claude-md-audit-workspace"
SKILL_DIR = ROOT / ".claude" / "skills" / "claude-md-audit"
TEST_SUITE = SKILL_DIR / "evals" / "test-suite.json"


def iteration_dir(iteration: int) -> Path:
    return WORKSPACE / f"iteration-{iteration}"


def read_json_file(path: Path) -> object:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def write_json_file(path: Path, payload: object) -> None:
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)


def find_next_iteration() -> int:
    if not WORKSPACE.exists():
        return 1
    nums = [
        int(match.group(1))
        for child in WORKSPACE.iterdir()
        if (match := re.match(r"iteration-(\d+)", child.name))
    ]
    return max(nums) + 1 if nums else 1


def load_suite() -> SuiteSpec:
    return cast("SuiteSpec", read_json_file(TEST_SUITE))


def resolve_prompt(test: TestSpec) -> str:
    prompt = test["prompt"]
    fixture_path = test.get("fixture_path")
    if fixture_path is not None and "{fixture_path}" in prompt:
        return prompt.replace("{fixture_path}", str(ROOT / fixture_path))
    return prompt


def find_claude() -> str:
    claude = shutil.which("claude")
    if claude is None:
        fail("Error: 'claude' CLI not found on PATH.")
    return claude


def parse_args(argv: list[str]) -> tuple[list[str], dict[str, str]]:
    positional: list[str] = []
    flags: dict[str, str] = {}
    index = 0
    while index < len(argv):
        if argv[index].startswith("--") and index + 1 < len(argv):
            flags[argv[index][2:]] = argv[index + 1]
            index += 2
            continue
        positional.append(argv[index])
        index += 1
    return positional, flags


def build_claude_cmd(
    claude: str,
    prompt: str,
    model: str | None = None,
) -> list[str]:
    cmd = [claude, "-p", prompt, "--verbose"]
    if model is not None:
        cmd.extend(["--model", model])
    return cmd


def banner(title: str, **fields: object) -> None:
    log()
    log(f"  ┌─ {title}")
    for key, value in fields.items():
        log(f"  │  {key}: {value}")
    log(f"  └{'─' * 60}")
    log()


def filter_tests(
    suite: SuiteSpec,
    test_filter: str | None,
) -> list[TestSpec]:
    tests = suite["tests"]
    if test_filter is None:
        return tests

    filtered = [test for test in tests if test["id"] == test_filter]
    if filtered:
        return filtered

    available = [test["id"] for test in tests]
    fail(
        f"  Error: no test matching '{test_filter}'.\n  Available: {available}"
    )


def build_eval_metadata(
    iteration: int,
    test: TestSpec,
    variant: RunVariant,
    prompt: str,
) -> EvalMetadata:
    return {
        "eval_id": iteration,
        "eval_name": f"{test['id']}-{variant}",
        "prompt": prompt,
        "target_repo": test.get("target_repo", "."),
        "assertions": test["assertions"],
    }


def setup(
    iteration: int | None = None,
    test_filter: str | None = None,
) -> SetupResult:
    current_iteration = iteration or find_next_iteration()
    suite = load_suite()
    tests = filter_tests(suite, test_filter)
    iter_dir = iteration_dir(current_iteration)

    banner(
        "setup",
        iteration=current_iteration,
        tests=f"{len(tests)} tests x 2 variants = {len(tests) * 2} runs",
        workspace=str(iter_dir),
    )

    for test in tests:
        prompt = resolve_prompt(test)
        for variant in RUN_VARIANTS:
            vdir = iter_dir / f"{test['id']}-{variant}"
            (vdir / "outputs").mkdir(parents=True, exist_ok=True)
            metadata = build_eval_metadata(
                current_iteration,
                test,
                variant,
                prompt,
            )
            write_json_file(vdir / "eval_metadata.json", metadata)

    log("  Workspace ready.")
    return {
        "iteration": current_iteration,
        "workspace": str(iter_dir),
        "tests": [test["id"] for test in tests],
    }


def ensure_iteration(
    iteration: int | None,
    test_filter: str | None,
) -> int:
    if iteration is None:
        return setup(test_filter=test_filter)["iteration"]
    if not iteration_dir(iteration).exists():
        setup(iteration=iteration, test_filter=test_filter)
    return iteration


def build_variant_prompt(
    variant: RunVariant,
    prompt: str,
    skill_path: Path,
    report_path: Path,
) -> str:
    if variant == "with-skill":
        parts = [
            "You have a skill available. Read it first, then follow its "
            "methodology.",
            f"Skill: {skill_path}",
            f"Task: {prompt}",
            f"Save your full report to: {report_path}",
        ]
        return "\n\n".join(parts)

    parts = [
        f"Task: {prompt}",
        "IMPORTANT: Do not use any skills or slash commands. Complete "
        "this task using only your own analysis.",
        f"Save your full report to: {report_path}",
    ]
    return "\n\n".join(parts)


def open_output_handle(path: Path) -> TextIO:
    return path.open("w", encoding="utf-8")


def launch_run_task(
    claude: str,
    test: TestSpec,
    variant: RunVariant,
    iter_dir: Path,
    skill_path: Path,
    model: str | None,
) -> RunTask:
    vdir = iter_dir / f"{test['id']}-{variant}"
    report_path = vdir / "outputs" / "report.md"
    prompt = build_variant_prompt(
        variant,
        resolve_prompt(test),
        skill_path,
        report_path,
    )
    cmd = build_claude_cmd(claude, prompt, model)
    stdout_handle = open_output_handle(vdir / "claude-stdout.txt")
    stderr_handle = open_output_handle(vdir / "claude-stderr.txt")

    try:
        process = subprocess.Popen(
            cmd,
            cwd=ROOT,
            stdin=subprocess.DEVNULL,
            stdout=stdout_handle,
            stderr=stderr_handle,
        )
    except Exception:
        stdout_handle.close()
        stderr_handle.close()
        raise

    return RunTask(
        test_id=test["id"],
        variant=variant,
        process=process,
        start_time=time.time(),
        vdir=vdir,
        stdout_handle=stdout_handle,
        stderr_handle=stderr_handle,
    )


def launch_run_tasks(
    claude: str,
    tests: list[TestSpec],
    iter_dir: Path,
    skill_path: Path,
    model: str | None,
) -> list[RunTask]:
    tasks: list[RunTask] = []
    for test in tests:
        for variant in RUN_VARIANTS:
            tasks.append(
                launch_run_task(
                    claude,
                    test,
                    variant,
                    iter_dir,
                    skill_path,
                    model,
                )
            )
    return tasks


def build_table_header(test_width: int) -> list[str]:
    return [
        (
            f"  {'Test':<{test_width}}  "
            f"{'with-skill':<{COLUMN_WIDTH}}  "
            f"{'baseline':<{COLUMN_WIDTH}}  {'Test':>6}"
        ),
        (
            f"  {'─' * test_width}  {'─' * COLUMN_WIDTH}  "
            f"{'─' * COLUMN_WIDTH}  {'─' * 6}"
        ),
    ]


def percentage(completed: int, total: int) -> int:
    if total == 0:
        return 0
    return int(completed / total * 100)


def format_run_cell(
    test_id: str,
    variant: RunVariant,
    state: dict[RunKey, RunCell],
    start_by: dict[RunKey, float],
    start_time: float,
    frame: int,
) -> str:
    cell = state.get((test_id, variant))
    if cell is None:
        return "—"
    if cell.status == "In-Progress":
        elapsed_s = time.time() - start_by.get((test_id, variant), start_time)
        spinner = SPINNER[frame % len(SPINNER)]
        return f"Running {elapsed_s:.0f}s{spinner}"

    elapsed_s = cell.elapsed_s or 0.0
    return f"{cell.status} ({elapsed_s:.0f}s)"


def render_run_board(
    test_ids: list[str],
    state: dict[RunKey, RunCell],
    start_by: dict[RunKey, float],
    total: int,
    start_time: float,
    frame: int,
) -> list[str]:
    test_width = max((len(test_id) for test_id in test_ids), default=4)
    done = sum(1 for cell in state.values() if cell.status != "In-Progress")
    lines = build_table_header(test_width)

    for test_id in test_ids:
        completed = sum(
            1
            for variant in RUN_VARIANTS
            if state[(test_id, variant)].status != "In-Progress"
        )
        progress = f"{percentage(completed, len(RUN_VARIANTS))}%"
        with_skill = format_run_cell(
            test_id,
            "with-skill",
            state,
            start_by,
            start_time,
            frame,
        )
        baseline = format_run_cell(
            test_id,
            "baseline",
            state,
            start_by,
            start_time,
            frame,
        )
        lines.append(
            f"  {test_id:<{test_width}}  {with_skill:<{COLUMN_WIDTH}}  "
            f"{baseline:<{COLUMN_WIDTH}}  {progress:>6}"
        )

    elapsed_s = time.time() - start_time
    lines.append("")
    lines.append(
        f"  Total: {done}/{total} ({percentage(done, total)}%) | "
        f"elapsed: {elapsed_s:.0f}s"
    )
    return lines


def emit_board(
    lines: list[str],
    prev_lines: int,
    redraw: bool,
) -> int:
    if redraw and prev_lines > 0:
        sys.stdout.write(f"\033[{prev_lines}A\033[J")
        sys.stdout.flush()
    for line in lines:
        log(line)
    return len(lines)


def finalize_run_task(task: RunTask, return_code: int) -> RunCell:
    duration = time.time() - task.start_time
    task.stdout_handle.close()
    task.stderr_handle.close()
    timing: TimingData = {
        "duration_ms": int(duration * 1000),
        "total_duration_seconds": round(duration, 1),
    }
    write_json_file(task.vdir / "timing.json", timing)
    status: RunStatus = "Done" if return_code == 0 else "Failed"
    return RunCell(status=status, elapsed_s=duration)


def poll_run_tasks(
    pending: list[RunTask],
    state: dict[RunKey, RunCell],
) -> list[RunTask]:
    still_pending: list[RunTask] = []
    for task in pending:
        return_code = task.process.poll()
        if return_code is None:
            still_pending.append(task)
            continue
        state[(task.test_id, task.variant)] = finalize_run_task(
            task,
            return_code,
        )
    return still_pending


def log_piped_run_updates(
    state: dict[RunKey, RunCell],
    done_now: int,
    total: int,
) -> None:
    pct = percentage(done_now, total)
    for (test_id, variant), cell in state.items():
        if cell.status not in {"Done", "Failed"} or cell.logged:
            continue
        elapsed_s = cell.elapsed_s or 0.0
        log(
            f"  [{done_now}/{total}] ({pct}%) {test_id:30s}  "
            f"{variant:<12s}  {cell.status} ({elapsed_s:.0f}s)"
        )
        cell.logged = True


def monitor_run_tasks(tasks: list[RunTask]) -> None:
    total = len(tasks)
    start_time = time.time()
    state: dict[RunKey, RunCell] = {
        (task.test_id, task.variant): RunCell(status="In-Progress")
        for task in tasks
    }
    start_by: dict[RunKey, float] = {
        (task.test_id, task.variant): task.start_time for task in tasks
    }
    test_ids = list(dict.fromkeys(task.test_id for task in tasks))
    is_tty = sys.stdout.isatty()
    prev_lines = emit_board(
        render_run_board(test_ids, state, start_by, total, start_time, 0),
        prev_lines=0,
        redraw=False,
    )

    pending = list(tasks)
    last_done = 0
    frame = 0
    while pending:
        time.sleep(POLL_INTERVAL)
        frame += 1
        pending = poll_run_tasks(pending, state)
        done_now = sum(
            1 for cell in state.values() if cell.status != "In-Progress"
        )
        changed = done_now != last_done
        last_done = done_now

        if is_tty:
            prev_lines = emit_board(
                render_run_board(
                    test_ids,
                    state,
                    start_by,
                    total,
                    start_time,
                    frame,
                ),
                prev_lines,
                redraw=True,
            )
            continue

        if changed:
            log_piped_run_updates(state, done_now, total)

    log(f"\n  All runs complete in {time.time() - start_time:.0f}s")


def run(
    iteration: int | None = None,
    model: str | None = None,
    test_filter: str | None = None,
) -> int:
    claude = find_claude()
    current_iteration = ensure_iteration(iteration, test_filter)
    suite = load_suite()
    tests = filter_tests(suite, test_filter)
    iter_dir = iteration_dir(current_iteration)
    skill_path = ROOT / suite["skill_path"]
    tasks = launch_run_tasks(claude, tests, iter_dir, skill_path, model)

    banner(
        "run",
        iteration=current_iteration,
        scope=f"{len(tests)} tests x 2 variants = {len(tasks)} runs",
        model=model or "default",
    )
    monitor_run_tasks(tasks)
    return current_iteration


def parse_grade_target(name: str) -> tuple[str, DisplayVariant]:
    if name.endswith("-with-skill"):
        return name[: -len("-with-skill")], "with-skill"
    if name.endswith("-baseline"):
        return name[: -len("-baseline")], "baseline"
    return name, "unknown"


def collect_grade_targets(iter_dir: Path) -> list[GradeTarget]:
    targets: list[GradeTarget] = []
    for child in sorted(iter_dir.iterdir()):
        if not child.is_dir():
            continue
        if not (child / "outputs" / "report.md").exists():
            continue
        if not (child / "eval_metadata.json").exists():
            continue
        test_id, variant = parse_grade_target(child.name)
        targets.append(GradeTarget(child, test_id, variant))
    return targets


def render_grade_board(
    test_ids: list[str],
    state: dict[GradeKey, str],
    total: int,
) -> list[str]:
    test_width = max((len(test_id) for test_id in test_ids), default=20)
    done = sum(
        1
        for status in state.values()
        if status not in {GRADE_PENDING, GRADE_RUNNING}
    )
    lines = build_table_header(test_width)

    for test_id in test_ids:
        with_skill = state.get((test_id, "with-skill"), "—")
        baseline = state.get((test_id, "baseline"), "—")
        cells = [with_skill, baseline]
        completed = sum(
            1
            for cell in cells
            if cell not in {GRADE_PENDING, GRADE_RUNNING, "—"}
        )
        progress = f"{percentage(completed, len(cells))}%"
        lines.append(
            f"  {test_id:<{test_width}}  {with_skill:<{COLUMN_WIDTH}}  "
            f"{baseline:<{COLUMN_WIDTH}}  {progress:>6}"
        )

    lines.append("")
    lines.append(f"  Total: {done}/{total} ({percentage(done, total)}%)")
    return lines


def redraw_grade_board(
    state: dict[GradeKey, str],
    test_ids: list[str],
    total: int,
    prev_lines: int,
) -> int:
    return emit_board(
        render_grade_board(test_ids, state, total),
        prev_lines,
        redraw=prev_lines > 0,
    )


def build_grade_prompt(
    report_path: Path,
    metadata_path: Path,
    grading_path: Path,
) -> str:
    parts = [
        f"Read the audit report at {report_path}.",
        f"Read the assertions from {metadata_path}.",
        "For each assertion, determine pass/fail with brief evidence "
        "from the report.",
        (
            f"Save the result to {grading_path} as JSON with this schema: "
            '{"eval_name": "...", "expectations": [{"text": '
            '"assertion text", "passed": true, "evidence": '
            '"brief quote or reason"}], "pass_rate": 0.0, "passed": 0, '
            '"failed": 0, "total": 0}'
        ),
    ]
    return " ".join(parts)


def grade_target(
    claude: str,
    target: GradeTarget,
    model: str | None,
) -> str:
    report_path = target.vdir / "outputs" / "report.md"
    metadata_path = target.vdir / "eval_metadata.json"
    grading_path = target.vdir / "grading.json"
    prompt = build_grade_prompt(report_path, metadata_path, grading_path)
    cmd = build_claude_cmd(claude, prompt, model)
    start_time = time.time()
    subprocess.run(
        cmd,
        check=False,
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    duration = time.time() - start_time
    if grading_path.exists():
        return f"Done ({duration:.0f}s)"
    return "Failed"


def log_grade_line(
    done: int,
    total: int,
    target: GradeTarget,
    status: str,
    *,
    carriage_return: bool = False,
    end: str = "\n",
) -> None:
    prefix = "\r" if carriage_return else ""
    pct = percentage(done, total)
    log(
        f"{prefix}  [{done}/{total}] ({pct}%) {target.test_id:30s}  "
        f"{target.variant:<12s}  {status}",
        end=end,
    )


def grade(iteration: int, model: str | None = None) -> None:
    claude = find_claude()
    iter_dir = iteration_dir(iteration)
    if not iter_dir.exists():
        fail(f"  Error: iteration-{iteration} not found.")

    targets = collect_grade_targets(iter_dir)
    total = len(targets)
    banner("grade", iteration=iteration, reports=f"{total} to grade")

    state: dict[GradeKey, str] = {
        (target.test_id, target.variant): GRADE_PENDING for target in targets
    }
    test_ids = list(dict.fromkeys(target.test_id for target in targets))
    is_tty = sys.stdout.isatty()
    prev_lines = 0
    done = 0

    for target in targets:
        key = (target.test_id, target.variant)
        grading_path = target.vdir / "grading.json"

        if grading_path.exists():
            state[key] = "Done (cached)"
            done += 1
            if is_tty:
                prev_lines = redraw_grade_board(
                    state,
                    test_ids,
                    total,
                    prev_lines,
                )
            else:
                log_grade_line(done, total, target, "Done (cached)")
            continue

        state[key] = GRADE_RUNNING
        if is_tty:
            prev_lines = redraw_grade_board(state, test_ids, total, prev_lines)
        else:
            log_grade_line(done, total, target, GRADE_RUNNING, end="")

        state[key] = grade_target(claude, target, model)
        done += 1
        if is_tty:
            prev_lines = redraw_grade_board(state, test_ids, total, prev_lines)
        else:
            log_grade_line(
                done,
                total,
                target,
                state[key],
                carriage_return=True,
            )

    log()


def load_grading_result(path: Path) -> GradingResult:
    return cast("GradingResult", read_json_file(path))


def load_timing_data(path: Path) -> TimingData:
    return cast("TimingData", read_json_file(path))


def aggregate(iteration: int) -> BenchmarkSummary:
    iter_dir = iteration_dir(iteration)
    if not iter_dir.exists():
        fail(f"  Error: iteration-{iteration} not found.")

    results: list[AggregateRow] = []
    for child in sorted(iter_dir.iterdir()):
        if not child.is_dir():
            continue
        grading_path = child / "grading.json"
        if not grading_path.exists():
            continue
        grading = load_grading_result(grading_path)
        timing_path = child / "timing.json"
        timing = load_timing_data(timing_path) if timing_path.exists() else {}
        results.append(
            {
                "name": grading.get("eval_name", child.name),
                "passed": grading.get("passed", 0),
                "failed": grading.get("failed", 0),
                "total": grading.get("total", 0),
                "pass_rate": grading.get("pass_rate", 0.0),
                "tokens": timing.get("total_tokens", 0),
                "duration_s": timing.get("total_duration_seconds", 0.0),
            }
        )

    total_assertions = sum(result["total"] for result in results)
    total_passed = sum(result["passed"] for result in results)
    summary: BenchmarkSummary = {
        "iteration": iteration,
        "results": results,
        "aggregate": {
            "total_assertions": total_assertions,
            "total_passed": total_passed,
            "overall_pass_rate": (
                round(total_passed / total_assertions, 3)
                if total_assertions
                else 0.0
            ),
        },
    }

    out_path = iter_dir / "benchmark.json"
    write_json_file(out_path, summary)

    banner("results", iteration=iteration, file=str(out_path))
    log(f"  {'Run':<45} {'Pass':>6} {'Total':>6} {'Rate':>7} {'Time':>7}")
    log(f"  {'─' * 45} {'─' * 6} {'─' * 6} {'─' * 7} {'─' * 7}")
    for result in results:
        rate = (
            f"{result['pass_rate'] * 100:.0f}%"
            if result["pass_rate"]
            else "N/A"
        )
        duration = (
            f"{result['duration_s']:.0f}s" if result["duration_s"] else "—"
        )
        log(
            f"  {result['name']:<45} {result['passed']:>6} "
            f"{result['total']:>6} {rate:>7} {duration:>7}"
        )
    log()
    log(
        "  Overall: "
        f"{total_passed}/{total_assertions} "
        f"({summary['aggregate']['overall_pass_rate'] * 100:.1f}%)"
    )
    return summary


def full(
    iteration: int | None = None,
    model: str | None = None,
    test_filter: str | None = None,
) -> None:
    current_iteration = run(iteration, model=model, test_filter=test_filter)
    grade(current_iteration, model=model)
    aggregate(current_iteration)


def status(iteration: int | None = None) -> None:
    current_iteration = iteration or (find_next_iteration() - 1)
    if current_iteration < 1:
        log("  No iterations found.")
        return
    aggregate(current_iteration)


def parse_iteration(
    flags: dict[str, str],
    positional: list[str],
) -> int | None:
    if "iteration" in flags:
        return int(flags["iteration"])
    if positional and positional[0].isdigit():
        return int(positional[0])
    return None


def main(argv: list[str]) -> int:
    if not argv:
        show_usage()
        return 0

    command = argv[0]
    positional, flags = parse_args(argv[1:])
    iteration = parse_iteration(flags, positional)
    model = flags.get("model")
    test_filter = flags.get("test")

    exit_code = 0
    if command == "setup":
        setup(iteration, test_filter=test_filter)
    elif command == "run":
        run(iteration, model=model, test_filter=test_filter)
    elif command == "grade":
        grade(iteration or (find_next_iteration() - 1), model=model)
    elif command == "aggregate":
        aggregate(iteration or (find_next_iteration() - 1))
    elif command == "full":
        full(iteration, model=model, test_filter=test_filter)
    elif command == "status":
        status(iteration)
    else:
        show_usage()
        exit_code = 1

    return exit_code


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
