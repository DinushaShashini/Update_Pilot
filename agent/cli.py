"""UpdatePilot Agent Command-Line Interface."""

import argparse
import getpass
import sys
from pathlib import Path
from typing import List, Optional

from agent.config import clear_device_id, get_default_config_path, load_config, save_config
from agent.pairing import (
    ExpiredCodeError,
    InsecureServerError,
    InvalidCodeError,
    NetworkError,
    PairingError,
    TLSError,
    call_pair_endpoint,
)
from agent.storage import delete_agent_token, save_agent_token


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

    return parser


def main(argv: Optional[List[str]] = None) -> int:
    """Entry point for the agent CLI."""
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
    else:
        parser.print_help(sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
