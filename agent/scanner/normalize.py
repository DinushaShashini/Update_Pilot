"""Normalisation, comparison keys, merging and deduplication for inventory records."""

import re
import unicodedata
from typing import Any, Dict, List, Optional, Set, Tuple

from agent.scanner.models import InstalledApp, SourceType

MAX_FIELD_LENGTH = 256

# Regex for control characters (excluding standard whitespace like space)
CONTROL_CHAR_RE = re.compile(r"[\x00-\x1f\x7f-\x9f]")

# Regex to strip common architecture qualifiers in comparison keys
ARCH_MARKER_RE = re.compile(
    r"\b(x64|x86|win64|win32|64-bit|32-bit|arm64|arm|ia64)\b|\((x64|x86|64-bit|32-bit|arm64)\)",
    re.IGNORECASE,
)

# Regex to strip non-alphanumeric punctuation in comparison keys
PUNCTUATION_RE = re.compile(r"[^\w\s]", re.UNICODE)


def clean_text(s: Optional[str], max_len: int = MAX_FIELD_LENGTH) -> Optional[str]:
    """Trim, collapse whitespace, strip control chars, and cap field length."""
    if s is None:
        return None

    # Remove non-printable control characters
    no_ctrl = CONTROL_CHAR_RE.sub("", s)

    # Collapse internal whitespace tabs/spaces/newlines into single space
    collapsed = " ".join(no_ctrl.split()).strip()

    if not collapsed:
        return None

    if len(collapsed) > max_len:
        return collapsed[:max_len].strip()

    return collapsed


def normalize_version(v: Optional[str]) -> str:
    """Normalize version string; returns 'Unknown' if missing or blank."""
    cleaned = clean_text(v)
    if not cleaned or cleaned.lower() in ("unknown", "none", "null"):
        return "Unknown"
    return cleaned


def make_comparison_name_key(name: str) -> str:
    """Generate a normalised comparison key for an application name.

    Lowercases, removes architecture markers (e.g. (x64), 32-bit),
    removes punctuation, and collapses whitespace.
    """
    cleaned = clean_text(name) or ""
    # Remove architecture markers
    no_arch = ARCH_MARKER_RE.sub(" ", cleaned)
    # Remove punctuation
    no_punct = PUNCTUATION_RE.sub(" ", no_arch)
    # Lowercase and collapse
    return " ".join(no_punct.lower().split())


def make_comparison_version_key(version: str) -> str:
    """Normalise version for matching (lower, collapse whitespace)."""
    norm_v = normalize_version(version).lower()
    if norm_v == "unknown":
        return ""
    # Strip non-alphanumeric/dot
    return re.sub(r"[^\w.]", "", norm_v)


def normalize_app(app: InstalledApp) -> InstalledApp:
    """Return a new InstalledApp with cleaned fields and bounded lengths."""
    clean_n = clean_text(app.name) or "Unknown Application"
    clean_v = normalize_version(app.version)
    clean_pub = clean_text(app.publisher)
    clean_id = clean_text(app.package_id)
    clean_raw = clean_text(app.raw_name) or clean_n

    return InstalledApp(
        name=clean_n,
        version=clean_v,
        publisher=clean_pub,
        package_id=clean_id,
        source=app.source,
        raw_name=clean_raw,
        publisher_source=app.publisher_source,
    )


def merge_and_deduplicate_apps(
    winget_apps: List[InstalledApp],
    registry_apps: List[InstalledApp],
) -> List[InstalledApp]:
    """Merge WinGet and registry records with deduplication and sorting.

    Rules:
    - Match by package ID when present in both.
    - Otherwise match by normalised name + normalised version.
    - When matched, prefer WinGet's package ID and the registry's publisher.
    - Set source to 'both' for matched records.
    - Deduplicate identical apps.
    - Sort results by name case-insensitively.
    """
    # 1. Normalise all inputs first
    norm_winget = [normalize_app(a) for a in winget_apps]
    norm_registry = [normalize_app(a) for a in registry_apps]

    # Deduplicate within registry list first
    deduped_registry: List[InstalledApp] = []
    seen_reg_keys: Set[Tuple[str, str]] = set()
    for reg_app in norm_registry:
        reg_key = (
            make_comparison_name_key(reg_app.name),
            make_comparison_version_key(reg_app.version),
        )
        if reg_key in seen_reg_keys:
            continue
        seen_reg_keys.add(reg_key)
        deduped_registry.append(reg_app)

    matched_reg_indices: Set[int] = set()
    merged_results: List[InstalledApp] = []

    # Map registry items by package_id and (name_key, version_key)
    reg_by_pkg_id: Dict[str, int] = {}
    reg_by_name_ver: Dict[Tuple[str, str], int] = {}

    for idx, reg_app in enumerate(deduped_registry):
        if reg_app.package_id:
            reg_by_pkg_id[reg_app.package_id.lower()] = idx
        name_key = make_comparison_name_key(reg_app.name)
        ver_key = make_comparison_version_key(reg_app.version)
        if (name_key, ver_key) not in reg_by_name_ver:
            reg_by_name_ver[(name_key, ver_key)] = idx

    # Match each WinGet app against registry items
    for w_app in norm_winget:
        reg_match_idx: Optional[int] = None

        # Try match by package ID
        if w_app.package_id and w_app.package_id.lower() in reg_by_pkg_id:
            candidate_idx = reg_by_pkg_id[w_app.package_id.lower()]
            if candidate_idx not in matched_reg_indices:
                reg_match_idx = candidate_idx

        # If not matched by package ID, match by normalised name + version
        if reg_match_idx is None:
            w_name_key = make_comparison_name_key(w_app.name)
            w_ver_key = make_comparison_version_key(w_app.version)
            candidate_key = (w_name_key, w_ver_key)

            if candidate_key in reg_by_name_ver:
                candidate_idx = reg_by_name_ver[candidate_key]
                if candidate_idx not in matched_reg_indices:
                    reg_match_idx = candidate_idx

        if reg_match_idx is not None:
            # Merged record
            matched_reg_indices.add(reg_match_idx)
            matched_reg = deduped_registry[reg_match_idx]

            # Prefer WinGet's package ID and Registry's publisher
            merged_package_id = w_app.package_id or matched_reg.package_id
            merged_publisher = matched_reg.publisher or w_app.publisher
            merged_pub_src = matched_reg.publisher_source or w_app.publisher_source

            merged_app = InstalledApp(
                name=w_app.name or matched_reg.name,
                version=w_app.version if w_app.version != "Unknown" else matched_reg.version,
                publisher=merged_publisher,
                package_id=merged_package_id,
                source="both",
                raw_name=w_app.raw_name or matched_reg.raw_name,
                publisher_source=merged_pub_src,
            )
            merged_results.append(merged_app)
        else:
            # WinGet-only record
            merged_results.append(w_app)

    # Add unmatched registry items
    for idx, reg_app in enumerate(deduped_registry):
        if idx not in matched_reg_indices:
            merged_results.append(reg_app)

    # Final deduplication pass across all records
    final_apps: List[InstalledApp] = []
    seen_final: Set[Tuple[Optional[str], str, str]] = set()

    for app in merged_results:
        norm_key = (
            app.package_id.lower() if app.package_id else None,
            make_comparison_name_key(app.name),
            make_comparison_version_key(app.version),
        )
        if norm_key in seen_final:
            continue
        seen_final.add(norm_key)
        final_apps.append(app)

    # Sort results alphabetically by name (case-insensitive)
    final_apps.sort(key=lambda a: a.name.lower())
    return final_apps
