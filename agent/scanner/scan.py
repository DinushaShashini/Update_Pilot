"""Application inventory scan orchestrator and operation runner."""

from datetime import datetime, timezone
import json
import logging
from pathlib import Path
import time
from typing import Callable, List, Optional

from agent.scanner.models import InstalledApp, ScanResult
from agent.scanner.normalize import merge_and_deduplicate_apps
from agent.scanner.publisher import enrich_apps_with_winget_show
from agent.scanner.registry import BaseRegistryBackend, scan_registry_installed
from agent.scanner.winget import get_winget_version, list_installed

logger = logging.getLogger("agent.scanner.scan")

OPERATION_NAME = "scan_inventory"

# Type alias for progress callback
ProgressCallback = Callable[[str, int], None]


def scan_inventory(
    progress_callback: Optional[ProgressCallback] = None,
    winget_cmd: Optional[str] = None,
    registry_backend: Optional[BaseRegistryBackend] = None,
    max_enrich: int = 0,
) -> ScanResult:
    """Execute complete application inventory scan in strict step order.

    Order of execution:
    1. Check WinGet availability (10%)
    2. Run winget list (35%)
    3. Read Windows Registry (60%)
    4. Enrich publisher metadata (75%)
    5. Normalise and merge (90%)
    6. Complete (100%)

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

    def report_progress(step: str, percent: int) -> None:
        if progress_callback:
            try:
                progress_callback(step, percent)
            except Exception as cb_err:
                logger.debug("Progress callback error: %s", cb_err)

    # Step 1: Check WinGet (10%)
    report_progress("check_winget", 10)
    version = get_winget_version(winget_cmd or "winget")
    if version:
        winget_available = True
    else:
        winget_available = False
        warnings.append("WinGet executable is not available or failed to respond.")

    # Step 2: Run winget list (35%)
    report_progress("winget_list", 35)
    if winget_available:
        try:
            winget_apps = list_installed(
                winget_cmd=winget_cmd,
                timeout=45,
                max_enrich=0,
            )
        except Exception as exc:
            winget_available = False
            warnings.append(f"WinGet inspection failed: {exc}")
            winget_apps = []

    # Step 3: Read Registry (60%)
    report_progress("registry_scan", 60)
    try:
        registry_apps, reg_warnings = scan_registry_installed(backend=registry_backend)
        warnings.extend(reg_warnings)
    except Exception as exc:
        reg_failed = True
        errors.append(f"Registry scanning failed: {exc}")
        registry_apps = []

    # Step 4: Enrich publisher metadata (75%)
    report_progress("enrich_publishers", 75)
    if max_enrich > 0 and winget_available and winget_apps:
        try:
            winget_apps = enrich_apps_with_winget_show(
                winget_apps,
                max_enrich=max_enrich,
                winget_cmd=winget_cmd or "winget",
                timeout=10,
            )
        except Exception as exc:
            warnings.append(f"Publisher enrichment error: {exc}")

    # Step 5: Normalise and merge (90%)
    report_progress("normalise_and_merge", 90)
    merged_apps: List[InstalledApp] = []
    try:
        merged_apps = merge_and_deduplicate_apps(winget_apps, registry_apps)
    except Exception as exc:
        errors.append(f"Normalisation and merge error: {exc}")

    # If both sources failed to yield any apps
    if not merged_apps and (not winget_available or len(winget_apps) == 0) and (reg_failed or len(registry_apps) == 0):
        if not any("failed" in e.lower() for e in errors):
            errors.append("Both WinGet and Registry inventory scans failed to produce applications.")

    # Step 6: Complete (100%)
    report_progress("completed", 100)
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
