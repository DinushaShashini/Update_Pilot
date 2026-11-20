"""Unit tests for read-only WinGet update detection (`agent/updates.py`)."""

from io import StringIO
import json
from pathlib import Path
import unittest
from unittest.mock import patch

from agent.cli import main as cli_main
from agent.config import is_operation_allowed
from agent.scanner.models import CheckUpdatesResult
from agent.scanner.runner import CommandResult
from agent.updates import check_updates, parse_winget_upgrade_output

UPGRADE_FIXTURE_PATH = Path(__file__).parent / "fixtures" / "winget" / "upgrade.txt"


class TestWingetUpgradeParser(unittest.TestCase):
    """Tests for parse_winget_upgrade_output against real and edge-case fixtures."""

    def test_parse_real_upgrade_fixture(self):
        raw = UPGRADE_FIXTURE_PATH.read_text(encoding="utf-8")
        updates, warnings = parse_winget_upgrade_output(raw)

        self.assertEqual(len(updates), 33)
        self.assertEqual(warnings, [])

        by_id = {u.package_id: u for u in updates}
        self.assertIn("7zip.7zip", by_id)
        self.assertEqual(by_id["7zip.7zip"].installed_version, "24.09")
        self.assertEqual(by_id["7zip.7zip"].available_version, "26.05")
        self.assertEqual(by_id["7zip.7zip"].source, "winget")

        self.assertIn("Git.Git", by_id)
        self.assertEqual(by_id["Git.Git"].installed_version, "2.50.0.2")
        self.assertEqual(by_id["Git.Git"].available_version, "2.56.0.3")

        self.assertIn("IObit.DriverBooster", by_id)
        self.assertEqual(by_id["IObit.DriverBooster"].installed_version, "< 14.0.1.462")
        self.assertEqual(by_id["IObit.DriverBooster"].available_version, "14.0.1.462")

        self.assertIn("Zoom.Zoom.EXE", by_id)
        self.assertEqual(by_id["Zoom.Zoom.EXE"].installed_version, "5.10.7 (6120)")
        self.assertEqual(by_id["Zoom.Zoom.EXE"].available_version, "7.2.1 (48556)")

    def test_handles_spinners_and_ansi_sequences(self):
        raw = (
            "\x1b[?25l-\r\\\r|\r/\r\x1b[?25h"
            "   \n-\n\\\n|\n/\n"
            "\x1b[32mName                Id             Version  Available Source\x1b[0m\n"
            "------------------------------------------------------------------\n"
            "Git                 Git.Git        2.50.0   2.56.0    winget\n"
            "1 upgrades available.\n"
        )
        updates, warnings = parse_winget_upgrade_output(raw)
        self.assertEqual(len(updates), 1)
        self.assertEqual(updates[0].package_id, "Git.Git")
        self.assertEqual(updates[0].available_version, "2.56.0")
        self.assertEqual(warnings, [])

    def test_handles_no_updates_found(self):
        for msg in [
            "No applicable update found.",
            "No installed package found matching input criteria.",
            "0 upgrades available.",
            "",
        ]:
            updates, warnings = parse_winget_upgrade_output(msg)
            self.assertEqual(updates, [])
            self.assertEqual(warnings, [])

    def test_handles_truncated_rows_and_unknown_versions(self):
        raw = (
            "Name                      Id                 Version  Available Source\n"
            "----------------------------------------------------------------------\n"
            "Very Long Application…    Vendor.LongApp     Unknown  2.0.0     winget\n"
            "Another Tool...           Vendor.Tool        1.0.0    Unknown   winget\n"
            "2 upgrades available.\n"
        )
        updates, warnings = parse_winget_upgrade_output(raw)
        self.assertEqual(len(updates), 2)
        self.assertTrue(updates[0].truncated)
        self.assertEqual(updates[0].name, "Very Long Application")
        self.assertEqual(updates[0].installed_version, "unknown")
        self.assertEqual(updates[0].available_version, "2.0.0")

        self.assertTrue(updates[1].truncated)
        self.assertEqual(updates[1].available_version, "unknown")
        self.assertTrue(any("truncated" in w.lower() for w in warnings))

    def test_handles_pinned_and_explicit_targeting_rows(self):
        raw = (
            "Name            Id               Version  Available Source\n"
            "----------------------------------------------------------\n"
            "Git             Git.Git          2.50.0   2.56.0    winget\n"
            "1 upgrades available.\n\n"
            "The following packages have an upgrade available, but require explicit targeting for upgrade:\n"
            "Name            Id               Version  Available Source\n"
            "----------------------------------------------------------\n"
            "Docker Desktop  Docker.Docker    4.30.0   4.35.0    winget\n"
        )
        updates, warnings = parse_winget_upgrade_output(raw)
        self.assertEqual(len(updates), 2)
        self.assertFalse(updates[0].pinned)
        self.assertTrue(updates[1].pinned)
        self.assertEqual(updates[1].package_id, "Docker.Docker")
        self.assertTrue(any("pinned" in w.lower() for w in warnings))


class TestCheckUpdatesExecutionAndCLI(unittest.TestCase):
    """Tests for check_updates runner, allow-list, and CLI command."""

    def test_check_updates_is_in_allow_list(self):
        self.assertTrue(is_operation_allowed("check_updates"))

    @patch("agent.updates.get_winget_version", return_value=None)
    def test_check_updates_winget_missing_returns_warning(self, _mock_ver):
        res = check_updates()
        self.assertIsInstance(res, CheckUpdatesResult)
        self.assertFalse(res.winget_available)
        self.assertEqual(res.updates, [])
        self.assertEqual(res.errors, [])
        self.assertTrue(any("not available" in w.lower() for w in res.warnings))

    @patch("agent.updates.run_command")
    @patch("agent.updates.get_winget_version", return_value="v1.29.380")
    def test_check_updates_runs_winget_upgrade_safely(self, _mock_ver, mock_run):
        fixture_text = UPGRADE_FIXTURE_PATH.read_text(encoding="utf-8")
        mock_run.return_value = CommandResult(exit_code=0, output=fixture_text, error_output="", timed_out=False)

        res = check_updates(winget_cmd="winget.exe", timeout=30)

        self.assertTrue(res.winget_available)
        self.assertEqual(len(res.updates), 33)
        self.assertEqual(res.errors, [])

        # Verify exact read-only argument list with required flags
        called_args = mock_run.call_args[0][0]
        self.assertEqual(
            called_args,
            ["winget.exe", "upgrade", "--accept-source-agreements", "--disable-interactivity"],
        )
        self.assertEqual(mock_run.call_args[1]["timeout"], 30)

    @patch("agent.updates.run_command")
    @patch("agent.updates.get_winget_version", return_value="v1.29.380")
    def test_check_updates_handles_no_updates_exit_code(self, _mock_ver, mock_run):
        mock_run.return_value = CommandResult(
            exit_code=-1978298325,
            output="No applicable update found.",
            error_output="",
            timed_out=False,
        )
        res = check_updates()
        self.assertTrue(res.winget_available)
        self.assertEqual(res.updates, [])
        self.assertEqual(res.errors, [])

    @patch("agent.cli.check_updates")
    def test_cli_check_updates_json_works_without_pairing(self, mock_check):
        mock_check.return_value = CheckUpdatesResult(
            updates=[],
            winget_available=True,
            checked_at="2026-11-12T12:00:00Z",
            warnings=[],
            errors=[],
        )
        stdout = StringIO()
        with patch("sys.stdout", stdout):
            exit_code = cli_main(["check-updates", "--json"])

        self.assertEqual(exit_code, 0)
        parsed = json.loads(stdout.getvalue())
        self.assertTrue(parsed["winget_available"])
        self.assertEqual(parsed["updates"], [])
        self.assertEqual(parsed["checked_at"], "2026-11-12T12:00:00Z")


if __name__ == "__main__":
    unittest.main()
