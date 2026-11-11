"""UpdatePilot Agent Command-Line Interface."""

import argparse
import getpass
import logging
import signal
import sys
import threading
from pathlib import Path
from typing import List, Optional

from agent.config import clear_device_id, get_default_config_path, load_config, save_config
from agent.heartbeat import run_heartbeat_loop
from agent.pairing import (
    ExpiredCodeError,
    InsecureServerError,
    InvalidCodeError,
    NetworkError,
    PairingError,
    TLSError,
    call_pair_endpoint,
)
from agent.scanner import run_scan
from agent.storage import delete_agent_token, get_agent_token, save_agent_token

logger = logging.getLogger("agent")


def prompt_pairing_code() -> str:
    """Prompt the user for a pairing code without echoing input."""
    try:
        code = getpass.getpass("Enter pairing code: ")
    except Exception:
        # Fallback for non-interactive / mocked stdin
        code = sys.stdin.readline().strip()
    return code.strip()


def run_pair(
    server_url: str,
    code: Optional[str] = None,
    config_path: Optional[Path] = None,
) -> int:
    """Execute the pair command.

    Args:
        server_url: The dashboard / backend API URL.
        code: Optional code; prompts securely if not provided.
        config_path: Optional path to config file.

    Returns:
        Exit code: 0 on success, 1 on failure.
    """
    pairing_code = (code or "").strip()
    if not pairing_code:
        pairing_code = prompt_pairing_code()

    if not pairing_code:
        sys.stderr.write("Error: Pairing code is required.\n")
        return 1

    try:
        device_id, token = call_pair_endpoint(server_url=server_url, code=pairing_code)
    except (InsecureServerError, TLSError, NetworkError, ExpiredCodeError, InvalidCodeError, PairingError) as e:
        sys.stderr.write(f"{e}\n")
        return 1
    except Exception as e:
        sys.stderr.write(f"Unexpected error during pairing: {e}\n")
        return 1

    try:
        # Save token in Windows Credential Manager
        save_agent_token(token)

        # Save ONLY server_url and device_id in config
        config_data = {
            "server_url": server_url.rstrip("/"),
            "device_id": device_id,
        }
        save_config(config_data, config_path=config_path)
    except Exception as e:
        sys.stderr.write(f"Error saving agent credentials: {e}\n")
        return 1

    sys.stdout.write(f"Successfully paired device (ID: {device_id}).\n")
    return 0


def run_unpair(config_path: Optional[Path] = None) -> int:
    """Execute the unpair command.

    Deletes the token from keyring and clears device_id from config.

    Returns:
        Exit code: 0 on success, 1 on failure.
    """
    try:
        delete_agent_token()
        clear_device_id(config_path=config_path)
        sys.stdout.write("Device successfully unpaired. Local credentials and device ID cleared.\n")
        return 0
    except Exception as e:
        sys.stderr.write(f"Error during unpair: {e}\n")
        return 1


def run_agent(
    interval_seconds: float = 30.0,
    config_path: Optional[Path] = None,
    shutdown_event: Optional[threading.Event] = None,
    max_iterations: Optional[int] = None,
) -> int:
    """Execute the agent background loop (heartbeats).

    Returns:
        Exit code: 0 on normal exit, 1 on error.
    """
    cfg = load_config(config_path)
    server_url = cfg.get("server_url")
    device_id = cfg.get("device_id")
    token = get_agent_token()

    if not server_url or not device_id or not token:
        msg = "Agent is not paired. Run 'agent pair --server <url>' first.\n"
        sys.stderr.write(f"Error: {msg}")
        logger.error(msg.strip())
        return 1

    stop_event = shutdown_event or threading.Event()

    # Wire up OS termination signals for clean shutdown
    def handle_signal(sig, frame):  # pragma: no cover
        logger.info("Signal received, initiating graceful shutdown...")
        stop_event.set()

    try:
        signal.signal(signal.SIGINT, handle_signal)
        signal.signal(signal.SIGTERM, handle_signal)
    except (ValueError, AttributeError):
        pass  # If not in main thread (e.g. tests)

    run_heartbeat_loop(
        server_url=server_url,
        token=token,
        interval_seconds=interval_seconds,
        config_path=config_path,
        shutdown_event=stop_event,
        max_iterations=max_iterations,
    )
    return 0


def execute_scan(
    server_url: Optional[str] = None,
    config_path: Optional[Path] = None,
) -> int:
    """Execute the application inventory scan command."""
    try:
        res = run_scan(server_url=server_url, config_path=config_path)
        sys.stdout.write(
            f"Scan completed: Discovered {res['total_discovered']} installed applications "
            f"({res['managed_count']} managed by WinGet/MSStore).\n"
        )
        return 0
    except Exception as e:
        sys.stderr.write(f"Scan failed: {e}\n")
        return 1


def build_parser() -> argparse.ArgumentParser:
    """Build argument parser for the agent CLI."""
    parser = argparse.ArgumentParser(
        prog="agent",
        description="UpdatePilot Windows Agent CLI",
    )
    subparsers = parser.add_subparsers(dest="command", help="Agent command to execute")

    # pair command
    pair_parser = subparsers.add_parser("pair", help="Pair the agent with an UpdatePilot server")
    pair_parser.add_argument(
        "--server",
        required=True,
        help="Backend server URL (e.g. https://dashboard.updatepilot.com)",
    )
    pair_parser.add_argument(
        "--code",
        default=None,
        help="Pairing code from dashboard (prompted if omitted for security)",
    )
    pair_parser.add_argument(
        "--config",
        dest="config_path",
        type=Path,
        default=None,
        help=argparse.SUPPRESS,  # internal/testing support
    )

    # unpair command
    unpair_parser = subparsers.add_parser("unpair", help="Unpair the agent and purge local credentials")
    unpair_parser.add_argument(
        "--config",
        dest="config_path",
        type=Path,
        default=None,
        help=argparse.SUPPRESS,
    )

    # run command
    run_parser = subparsers.add_parser("run", help="Run the agent heartbeat background loop")
    run_parser.add_argument(
        "--interval",
        type=float,
        default=30.0,
        help="Heartbeat interval in seconds (default: 30)",
    )
    run_parser.add_argument(
        "--config",
        dest="config_path",
        type=Path,
        default=None,
        help=argparse.SUPPRESS,
    )

    # scan command
    scan_parser = subparsers.add_parser("scan", help="Scan installed applications via WinGet and report to dashboard")
    scan_parser.add_argument(
        "--server",
        default=None,
        help="Optional server URL override",
    )
    scan_parser.add_argument(
        "--config",
        dest="config_path",
        type=Path,
        default=None,
        help=argparse.SUPPRESS,
    )

    return parser


def main(argv: Optional[List[str]] = None) -> int:
    """Entry point for the agent CLI."""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command == "pair":
        return run_pair(
            server_url=args.server,
            code=args.code,
            config_path=getattr(args, "config_path", None),
        )
    elif args.command == "unpair":
        return run_unpair(config_path=getattr(args, "config_path", None))
    elif args.command == "run":
        return run_agent(
            interval_seconds=args.interval,
            config_path=getattr(args, "config_path", None),
        )
    elif args.command == "scan":
        return execute_scan(
            server_url=args.server,
            config_path=getattr(args, "config_path", None),
        )
    else:
        parser.print_help(sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
