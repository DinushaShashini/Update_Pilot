"""Agent configuration management.

Stores non-sensitive runtime configuration (server URL and deviceId).
Plaintext secrets, tokens, or codes are NEVER stored here.
"""

import json
import os
from pathlib import Path
from typing import Any, Dict, Optional

CONFIG_DIR_ENV = "UPDATEPILOT_CONFIG_DIR"
CONFIG_FILE_NAME = "config.json"

# Strict allow-list of agent-supported operations
ALLOWED_OPERATIONS = frozenset({"scan_inventory", "check_updates", "apply_update"})


def is_operation_allowed(operation: str) -> bool:
    """Return True if the requested operation is in the allowed set."""
    return operation in ALLOWED_OPERATIONS


def get_default_config_dir() -> Path:
    """Return the configuration directory path."""
    env_dir = os.environ.get(CONFIG_DIR_ENV)
    if env_dir:
        return Path(env_dir)
    # Default to user's home directory .updatepilot
    return Path.home() / ".updatepilot"


def get_default_config_path() -> Path:
    """Return the default config.json path."""
    return get_default_config_dir() / CONFIG_FILE_NAME


def load_config(config_path: Optional[Path] = None) -> Dict[str, Any]:
    """Load configuration from disk. Returns empty dict if file does not exist."""
    path = config_path or get_default_config_path()
    if not path.is_file():
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return {}


def save_config(config: Dict[str, Any], config_path: Optional[Path] = None) -> None:
    """Save configuration to disk.

    Only server_url and device_id are persisted.
    Strictly forbids saving credentials, tokens, or codes.
    """
    path = config_path or get_default_config_path()
    path.parent.mkdir(parents=True, exist_ok=True)

    # Sanitize: ensure no secret fields can ever be stored
    forbidden_keys = {"token", "agent_token", "code", "pairing_code", "pairing_token", "password"}
    for key in forbidden_keys:
        if key in config:
            raise ValueError(f"Security error: '{key}' must never be written to configuration.")

    # Only persist allowed fields
    sanitized: Dict[str, Any] = {}
    if "server_url" in config:
        sanitized["server_url"] = config["server_url"]
    if "device_id" in config:
        sanitized["device_id"] = config["device_id"]

    with open(path, "w", encoding="utf-8") as f:
        json.dump(sanitized, f, indent=2)


def clear_device_id(config_path: Optional[Path] = None) -> None:
    """Clear device_id from configuration upon unpairing."""
    cfg = load_config(config_path)
    if "device_id" in cfg:
        cfg["device_id"] = None
        save_config(cfg, config_path)
