"""Windows Registry Uninstall keys scanner for installed applications."""

import logging
import re
from typing import Any, Dict, List, Optional, Set, Tuple

from agent.scanner.models import InstalledApp

logger = logging.getLogger("agent.scanner.registry")

try:
    import winreg
except ImportError:
    winreg = None

UNINSTALL_SUBKEY = r"Software\Microsoft\Windows\CurrentVersion\Uninstall"

# Patterns to filter out Windows updates and hotfix patches
PATCH_PATTERNS = [
    re.compile(r"^Security Update for", re.IGNORECASE),
    re.compile(r"^Update for (Windows|Microsoft)", re.IGNORECASE),
    re.compile(r"^Hotfix for", re.IGNORECASE),
    re.compile(r"\(KB\d+\)$", re.IGNORECASE),
    re.compile(r"^KB\d+", re.IGNORECASE),
]


_SENTINEL = object()


class BaseRegistryBackend:
    """Interface for querying registry keys."""

    def read_all_uninstall_entries(self) -> Tuple[List[Dict[str, Any]], List[str]]:
        """Return list of raw entry dicts and any diagnostic warning strings."""
        raise NotImplementedError


class WindowsRegistryBackend(BaseRegistryBackend):
    """Standard Windows registry reader using Python's winreg module."""

    def __init__(self, winreg_module: Any = _SENTINEL):
        self.reg = winreg if winreg_module is _SENTINEL else winreg_module

    def read_all_uninstall_entries(self) -> Tuple[List[Dict[str, Any]], List[str]]:
        if not self.reg:
            return [], ["winreg module is not available on this platform"]

        entries: List[Dict[str, Any]] = []
        warnings: List[str] = []

        hives_to_query = [
            (
                self.reg.HKEY_LOCAL_MACHINE,
                UNINSTALL_SUBKEY,
                self.reg.KEY_READ | getattr(self.reg, "KEY_WOW64_64KEY", 0x0100),
                "HKLM (64-bit)",
            ),
            (
                self.reg.HKEY_LOCAL_MACHINE,
                UNINSTALL_SUBKEY,
                self.reg.KEY_READ | getattr(self.reg, "KEY_WOW64_32KEY", 0x0200),
                "HKLM (32-bit WOW64)",
            ),
            (
                self.reg.HKEY_CURRENT_USER,
                UNINSTALL_SUBKEY,
                self.reg.KEY_READ,
                "HKCU",
            ),
        ]

        for root_key, subkey_path, access_flags, hive_label in hives_to_query:
            try:
                root_handle = self.reg.OpenKey(root_key, subkey_path, 0, access_flags)
            except FileNotFoundError:
                warnings.append(f"Registry key not found: {hive_label}\\{subkey_path}")
                continue
            except PermissionError as exc:
                warnings.append(f"Permission denied accessing {hive_label}\\{subkey_path}: {exc}")
                continue
            except OSError as exc:
                warnings.append(f"Failed opening {hive_label}\\{subkey_path}: {exc}")
                continue

            with root_handle:
                try:
                    num_subkeys, _, _ = self.reg.QueryInfoKey(root_handle)
                except OSError as exc:
                    warnings.append(f"Failed querying key info for {hive_label}: {exc}")
                    continue

                for i in range(num_subkeys):
                    try:
                        subkey_name = self.reg.EnumKey(root_handle, i)
                        sub_handle = self.reg.OpenKey(root_handle, subkey_name, 0, access_flags)
                    except (OSError, PermissionError) as exc:
                        warnings.append(f"Could not open subkey index {i} in {hive_label}: {exc}")
                        continue

                    with sub_handle:
                        entry_dict: Dict[str, Any] = {"_subkey_name": subkey_name, "_hive": hive_label}
                        # We only query the allowed attributes
                        for val_name in ("DisplayName", "DisplayVersion", "Publisher", "SystemComponent", "ParentKeyName", "ReleaseType"):
                            try:
                                val, _ = self.reg.QueryValueEx(sub_handle, val_name)
                                entry_dict[val_name] = val
                            except FileNotFoundError:
                                pass
                            except (OSError, ValueError) as exc:
                                warnings.append(f"Malformed value '{val_name}' in {hive_label}\\{subkey_name}: {exc}")

                        entries.append(entry_dict)

        return entries, warnings


class FakeRegistryBackend(BaseRegistryBackend):
    """In-memory injectable registry backend for testing and cross-platform verification."""

    def __init__(
        self,
        entries: Optional[List[Dict[str, Any]]] = None,
        warnings: Optional[List[str]] = None,
    ):
        self.entries = list(entries or [])
        self.warnings = list(warnings or [])

    def read_all_uninstall_entries(self) -> Tuple[List[Dict[str, Any]], List[str]]:
        return list(self.entries), list(self.warnings)


def should_skip_registry_entry(entry: Dict[str, Any]) -> bool:
    """Determine whether a raw uninstall entry should be filtered out.

    Skips:
    - Missing or empty DisplayName
    - SystemComponent == 1
    - Sub-components with ParentKeyName
    - OS/Security updates and hotfixes
    """
    raw_name = entry.get("DisplayName")
    if not raw_name or not isinstance(raw_name, str) or not raw_name.strip():
        return True

    name = raw_name.strip()

    # SystemComponent flag
    system_component = entry.get("SystemComponent")
    if system_component in (1, "1", True):
        return True

    # ParentKeyName indicates patch or sub-feature
    parent_key = entry.get("ParentKeyName")
    if parent_key and str(parent_key).strip():
        return True

    # ReleaseType indicates update / patch
    release_type = str(entry.get("ReleaseType") or "").strip().lower()
    if release_type in ("security update", "update", "hotfix", "patch"):
        return True

    # Name-based patch detection
    if any(pat.search(name) for pat in PATCH_PATTERNS):
        return True

    return False


def scan_registry_installed(
    backend: Optional[BaseRegistryBackend] = None,
) -> Tuple[List[InstalledApp], List[str]]:
    """Scan registry for installed software using injected or default backend.

    Collects DisplayName, DisplayVersion and Publisher only.
    Filters out system components, patches, and duplicates.
    """
    active_backend = backend or WindowsRegistryBackend()
    raw_entries, warnings = active_backend.read_all_uninstall_entries()

    apps: List[InstalledApp] = []
    seen_dedup: Set[Tuple[str, str]] = set()

    for entry in raw_entries:
        if should_skip_registry_entry(entry):
            continue

        name = str(entry.get("DisplayName", "")).strip()
        version = str(entry.get("DisplayVersion") or "").strip() or "Unknown"
        raw_pub = entry.get("Publisher")
        publisher = str(raw_pub).strip() if raw_pub and str(raw_pub).strip() else None

        dedup_key = (name.lower(), version.lower())
        if dedup_key in seen_dedup:
            continue
        seen_dedup.add(dedup_key)

        apps.append(
            InstalledApp(
                name=name,
                version=version,
                publisher=publisher,
                package_id=None,
                source="registry",
                raw_name=name,
                publisher_source="registry" if publisher else None,
            )
        )

    return apps, warnings
