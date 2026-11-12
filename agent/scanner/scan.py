"""Application inventory scan orchestrator and operation runner."""

from datetime import datetime, timezone
import inspect
import json
import logging
from pathlib import Path
import time
from typing import Any, Callable, List, Optional

from agent.scanner.models import InstalledApp, ScanResult
from agent.scanner.normalize import merge_and_deduplicate_apps
from agent.scanner.progress import SCAN_STEPS, compute_step_percentages
from agent.scanner.publisher import enrich_apps_with_winget_show
from agent.scanner.registry import BaseRegistryBackend, scan_registry_installed
from agent.scanner.winget import get_winget_version, list_installed

logger = logging.getLogger("agent.scanner.scan")

OPERATION_NAME = "scan_inventory"

# Type alias for progress callback: (step, percent) or (step, percent, message, skipped)
ProgressCallback = Callable[..., None]


def scan_inventory(
    progress_callback: Optional[ProgressCallback] = None,
    winget_cmd: Optional[str] = None,
    registry_backend: Optional[BaseRegistryBackend] = None,
    max_enrich: int = 0,
) -> ScanResult:
    """Execute complete application inventory scan in strict step order.

    Order of execution (defined in SCAN_STEPS):
    1. checking_winget (5%)
    2. listing_winget (30%)
    3. reading_registry (20%)
    4. enriching_publishers (15%, skipped if disabled with weight redistributed)
    5. normalising_and_merging (10%)
    (Followed by submitting_results 10% and backend matching_packages 10%)

    Resilience rules:
    - If WinGet is missing or fails, continue with registry only and record warning.
    - If Registry fails, continue with WinGet only and record warning/error.
    - If both fail, return structured error ScanResult and never crash.
    - Logs counts and timings only (never logs individual app names or lists).
    """
    started_at = datetime.now(timezone.utc).isoformat()
    start_time = time.perf_counter()

    warnings: List[str] = []
    errors: List[str] = []
    winget_available = False
    winget_apps: List[InstalledApp] = []
    registry_apps: List[InstalledApp] = []
    reg_failed = False

    skip_enrich = max_enrich <= 0
    step_targets = compute_step_percentages(skip_enrich=skip_enrich)
    last_percent = 0

    def _invoke_callback(step: str, percent: int, message: str, skipped: bool) -> None:
        nonlocal last_percent
        # Enforce strictly non-decreasing percentages
        safe_pct = max(last_percent, min(100, int(percent)))
        last_percent = safe_pct

        if not progress_callback:
            return
        try:
            sig = inspect.signature(progress_callback)
            params = list(sig.parameters.values())
            has_varargs = any(p.kind == inspect.Parameter.VAR_POSITIONAL for p in params)
            if has_varargs or len(params) >= 4:
                progress_callback(step, safe_pct, message, skipped)
            elif len(params) == 3:
                progress_callback(step, safe_pct, message)
            else:
                progress_callback(step, safe_pct)
        except Exception as cb_err:
            logger.debug("Progress callback error: %s", cb_err)

    # Step 1: checking_winget
    version = get_winget_version(winget_cmd or "winget")
    if version:
        winget_available = True
        _invoke_callback("checking_winget", step_targets["checking_winget"], f"WinGet {version} detected", False)
    else:
        winget_available = False
        warnings.append("WinGet executable is not available or failed to respond.")
        _invoke_callback("checking_winget", step_targets["checking_winget"], "WinGet unavailable; using registry", False)

    # Step 2: listing_winget
    if winget_available:
        try:
            winget_apps = list_installed(
                winget_cmd=winget_cmd,
                timeout=45,
                max_enrich=0,
            )
            _invoke_callback(
                "listing_winget",
                step_targets["listing_winget"],
                f"Found {len(winget_apps)} WinGet apps",
                False,
            )
        except Exception as exc:
            winget_available = False
            warnings.append(f"WinGet inspection failed: {exc}")
            winget_apps = []
            _invoke_callback("listing_winget", step_targets["listing_winget"], "WinGet list failed", False)
    else:
        _invoke_callback("listing_winget", step_targets["listing_winget"], "Skipped (WinGet unavailable)", True)

    # Step 3: reading_registry
    try:
        registry_apps, reg_warnings = scan_registry_installed(backend=registry_backend)
        warnings.extend(reg_warnings)
        _invoke_callback(
            "reading_registry",
            step_targets["reading_registry"],
            f"Found {len(registry_apps)} registry entries",
            False,
        )
    except Exception as exc:
        reg_failed = True
        errors.append(f"Registry scanning failed: {exc}")
        registry_apps = []
        _invoke_callback("reading_registry", step_targets["reading_registry"], "Registry scan failed", False)

    # Step 4: enriching_publishers
    if not skip_enrich and winget_available and winget_apps:
        try:
            winget_apps = enrich_apps_with_winget_show(
                winget_apps,
                max_enrich=max_enrich,
                winget_cmd=winget_cmd or "winget",
                timeout=10,
            )
            _invoke_callback(
                "enriching_publishers",
                step_targets["enriching_publishers"],
                f"Enriched {min(max_enrich, len(winget_apps))} publishers",
                False,
            )
        except Exception as exc:
            warnings.append(f"Publisher enrichment error: {exc}")
            _invoke_callback(
                "enriching_publishers",
                step_targets["enriching_publishers"],
                "Publisher enrichment completed with warnings",
                False,
            )
    else:
        reason = "Skipped (disabled)" if skip_enrich else "Skipped (no WinGet apps)"
        _invoke_callback("enriching_publishers", step_targets["enriching_publishers"], reason, True)

    # Step 5: normalising_and_merging
    merged_apps: List[InstalledApp] = []
    try:
        merged_apps = merge_and_deduplicate_apps(winget_apps, registry_apps)
    except Exception as exc:
        errors.append(f"Normalisation and merge error: {exc}")

    # If both sources failed to yield any apps
    if not merged_apps and (not winget_available or len(winget_apps) == 0) and (reg_failed or len(registry_apps) == 0):
        if not any("failed" in e.lower() for e in errors):
            errors.append("Both WinGet and Registry inventory scans failed to produce applications.")

    _invoke_callback(
        "normalising_and_merging",
        step_targets["normalising_and_merging"],
        f"Found {len(merged_apps)} apps",
        False,
    )
    finished_at = datetime.now(timezone.utc).isoformat()
    elapsed = time.perf_counter() - start_time

    # Log counts and timing only (no app details)
    logger.info(
        "Inventory scan finished in %.2fs: %d apps found (WinGet available: %s, Warnings: %d, Errors: %d).",
        elapsed,
        len(merged_apps),
        winget_available,
        len(warnings),
        len(errors),
    )

    return ScanResult(
        apps=merged_apps,
        started_at=started_at,
        finished_at=finished_at,
        warnings=warnings,
        errors=errors,
        winget_available=winget_available,
    )
