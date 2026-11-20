"""Shared scan progress steps, weights, and percentage calculation."""

from typing import Dict, List, Tuple

# Ordered scan steps and their percentage weights (total = 100%).
# Agent steps sum to 90%; backend matching_packages accounts for the final 10%.
SCAN_STEPS: List[Tuple[str, int]] = [
    ("checking_winget", 5),
    ("listing_winget", 30),
    ("reading_registry", 20),
    ("enriching_publishers", 15),
    ("normalising_and_merging", 10),
    ("submitting_results", 10),
    ("matching_packages", 10),
]

AGENT_TOTAL_WEIGHT = 90
BACKEND_MATCHING_WEIGHT = 10


def compute_step_percentages(skip_enrich: bool = False) -> Dict[str, int]:
    """Compute cumulative percentage target at the completion of each step.

    When ``skip_enrich`` is True, the 15% weight of ``enriching_publishers`` is
    redistributed proportionally across the remaining active agent steps so that
    ``submitting_results`` still reaches 90% and ``matching_packages`` finishes
    at 100%. Percentages are guaranteed to be monotonically non-decreasing.
    """
    agent_steps = [(name, w) for name, w in SCAN_STEPS if name != "matching_packages"]

    active_weight_sum = sum(
        w for name, w in agent_steps if not (skip_enrich and name == "enriching_publishers")
    )

    cumulative = 0.0
    result: Dict[str, int] = {}
    last_pct = 0

    for name, weight in agent_steps:
        if skip_enrich and name == "enriching_publishers":
            result[name] = last_pct
            continue

        if active_weight_sum > 0:
            scaled_weight = (weight / active_weight_sum) * AGENT_TOTAL_WEIGHT
        else:
            scaled_weight = 0.0

        cumulative += scaled_weight
        pct = min(AGENT_TOTAL_WEIGHT, max(last_pct, round(cumulative)))
        result[name] = pct
        last_pct = pct

    # Ensure submitting_results ends cleanly at 90%
    result["submitting_results"] = max(last_pct, AGENT_TOTAL_WEIGHT)
    result["matching_packages"] = 100
    return result
