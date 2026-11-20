"""Safe external command execution runner with memory caps and structured errors."""

import logging
import subprocess
from dataclasses import dataclass
from typing import List, Optional, Sequence, Union

logger = logging.getLogger("agent.scanner.runner")

DEFAULT_MAX_OUTPUT_BYTES = 5 * 1024 * 1024  # 5 MB cap on untrusted output


@dataclass
class CommandResult:
    """Structured result of command execution."""

    exit_code: int
    output: str
    error_output: str
    timed_out: bool
    error: Optional[str] = None

    def __iter__(self):
        """Allow tuple unpacking: exit_code, output, timed_out."""
        return iter((self.exit_code, self.output, self.timed_out))


def run_command(
    args: Sequence[str],
    timeout: int = 30,
    max_output_bytes: int = DEFAULT_MAX_OUTPUT_BYTES,
) -> CommandResult:
    """Execute an external command safely using an argument list without a shell.

    - Strict argument list enforcement (no shell=True).
    - Caps output byte size to prevent memory exhaustion from untrusted processes.
    - Decodes with UTF-8 and safe fallback (errors="replace").
    - Catches missing executables and timeouts, returning structured errors instead of raising.
    """
    if isinstance(args, str):
        return CommandResult(
            exit_code=-1,
            output="",
            error_output="args must be a list or sequence of strings, never a raw shell string",
            timed_out=False,
            error="invalid command shape: shell string rejected",
        )

    if not args or not all(isinstance(a, str) for a in args):
        return CommandResult(
            exit_code=-1,
            output="",
            error_output="args must contain at least one string element",
            timed_out=False,
            error="invalid command arguments",
        )

    try:
        proc = subprocess.run(
            list(args),
            shell=False,
            capture_output=True,
            timeout=timeout,
        )

        raw_stdout = proc.stdout or b""
        raw_stderr = proc.stderr or b""

        if len(raw_stdout) > max_output_bytes:
            raw_stdout = raw_stdout[:max_output_bytes]
        if len(raw_stderr) > max_output_bytes:
            raw_stderr = raw_stderr[:max_output_bytes]

        decoded_stdout = raw_stdout.decode("utf-8", errors="replace")
        decoded_stderr = raw_stderr.decode("utf-8", errors="replace")

        return CommandResult(
            exit_code=proc.returncode,
            output=decoded_stdout,
            error_output=decoded_stderr,
            timed_out=False,
            error=None if proc.returncode == 0 else (decoded_stderr.strip() or f"exit code {proc.returncode}"),
        )

    except FileNotFoundError:
        return CommandResult(
            exit_code=-1,
            output="",
            error_output=f"executable not found: {args[0]}",
            timed_out=False,
            error="command not found",
        )

    except subprocess.TimeoutExpired as exc:
        raw_out = exc.stdout or b""
        raw_err = exc.stderr or b""
        if isinstance(raw_out, str):
            out_str = raw_out[:max_output_bytes]
        else:
            out_str = (raw_out[:max_output_bytes]).decode("utf-8", errors="replace")

        if isinstance(raw_err, str):
            err_str = raw_err[:max_output_bytes]
        else:
            err_str = (raw_err[:max_output_bytes]).decode("utf-8", errors="replace")

        return CommandResult(
            exit_code=-1,
            output=out_str,
            error_output=err_str or f"timed out after {timeout} seconds",
            timed_out=True,
            error=f"command timed out after {timeout} seconds",
        )

    except OSError as exc:
        return CommandResult(
            exit_code=-1,
            output="",
            error_output=str(exc),
            timed_out=False,
            error=f"operating system error: {exc}",
        )
