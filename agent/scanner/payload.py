"""Scan result payload formatter and JSON schema validation."""

from typing import Any, Dict, List, Optional
import jsonschema

from agent.scanner.models import InstalledApp, ScanResult

SCAN_PAYLOAD_SCHEMA: Dict[str, Any] = {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "title": "AgentScanPayload",
    "type": "object",
    "required": ["exit_code", "discovered_packages", "available_upgrades", "raw_stderr"],
    "properties": {
        "exit_code": {
            "type": "integer",
            "description": "0 for success, non-zero on scan failure",
        },
        "discovered_packages": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["name", "installed_version", "is_managed"],
                "properties": {
                    "name": {"type": "string"},
                    "package_id": {"type": ["string", "null"]},
                    "installed_version": {"type": "string"},
                    "available_version": {"type": ["string", "null"]},
                    "source": {"type": ["string", "null"]},
                    "is_managed": {"type": "boolean"},
                },
                "additionalProperties": True,
            },
        },
        "available_upgrades": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["name", "package_id", "installed_version", "target_version"],
                "properties": {
                    "name": {"type": "string"},
                    "package_id": {"type": "string"},
                    "installed_version": {"type": "string"},
                    "target_version": {"type": "string"},
                    "source": {"type": ["string", "null"]},
                },
            },
        },
        "raw_stderr": {
            "type": "string",
            "description": "Error or diagnostic traces from subprocesses",
        },
    },
    "additionalProperties": False,
}


def is_package_managed(app: InstalledApp) -> bool:
    """Return True if package is managed by WinGet/MSStore and has standard package ID."""
    if not app.package_id:
        return False
    pid = app.package_id.strip()
    if pid.startswith("{") or pid.upper().startswith("ARP\\"):
        return False
    if "." in pid and app.source in ("winget", "both"):
        return True
    return False


def convert_scan_result_to_api_payload(scan_result: ScanResult) -> Dict[str, Any]:
    """Convert ScanResult into the JSON payload defined in docs/api.md.

    Validates payload against SCAN_PAYLOAD_SCHEMA before returning.
    """
    discovered_packages: List[Dict[str, Any]] = []

    for app in scan_result.apps:
        is_managed = is_package_managed(app)
        source_val = app.source if app.source in ("winget", "both") else None

        discovered_packages.append({
            "name": app.name,
            "package_id": app.package_id,
            "installed_version": app.version,
            "available_version": None,
            "source": source_val,
            "is_managed": is_managed,
            "publisher": app.publisher,
        })

    raw_stderr = "\n".join(scan_result.errors) if scan_result.errors else ""
    exit_code = 0 if not scan_result.errors else 1

    payload: Dict[str, Any] = {
        "exit_code": exit_code,
        "discovered_packages": discovered_packages,
        "available_upgrades": [],
        "raw_stderr": raw_stderr,
    }

    validate_scan_payload(payload)
    return payload


def validate_scan_payload(payload: Dict[str, Any]) -> None:
    """Validate scan results payload against the schema.

    Raises jsonschema.ValidationError if invalid.
    """
    jsonschema.validate(instance=payload, schema=SCAN_PAYLOAD_SCHEMA)
