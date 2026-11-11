"""Unit tests for WinGet version detection, command execution, and table output parser."""

import os
from pathlib import Path
import unittest
from unittest.mock import MagicMock, patch

from agent.scanner.models import InstalledApp
from agent.scanner.runner import CommandResult
from agent.scanner.winget import (
    clean_ansi,
    get_winget_version,
    list_installed,
    parse_winget_list_output,
)

FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures" / "winget"
REAL_LIST_FIXTURE_PATH = FIXTURES_DIR / "list.txt"


class TestWinGetScanner(unittest.TestCase):
    """Test WinGet CLI execution and table parser."""

    @patch("agent.scanner.winget.run_command")
    def test_get_winget_version_success(self, mock_cmd):
        mock_cmd.return_value = CommandResult(
            exit_code=0,
            output="v1.29.380\n",
            error_output="",
            timed_out=False,
        )
        version = get_winget_version()
        self.assertEqual(version, "v1.29.380")
        mock_cmd.assert_called_once_with(["winget", "--version"], timeout=10)

    @patch("agent.scanner.winget.run_command")
    def test_get_winget_version_failure(self, mock_cmd):
        mock_cmd.return_value = CommandResult(
            exit_code=-1,
            output="",
            error_output="command not found",
            timed_out=False,
            error="command not found",
        )
        self.assertIsNone(get_winget_version())

    def test_parse_real_fixture_list_txt(self):
        """Verify parsing 193 applications from the real Windows 11 host fixture."""
        with open(REAL_LIST_FIXTURE_PATH, "r", encoding="utf-8") as f:
            raw_text = f.read()

        apps = parse_winget_list_output(raw_text)
        self.assertEqual(len(apps), 193)

        # Check first app: 7-Zip
        first = apps[0]
        self.assertEqual(first.name, "7-Zip 24.09 (x64)")
        self.assertEqual(first.package_id, "7zip.7zip")
        self.assertEqual(first.version, "24.09")
        self.assertEqual(first.source, "winget")
        self.assertEqual(first.raw_name, "7-Zip 24.09 (x64)")
        self.assertEqual(first.publisher, "7zip")
        self.assertEqual(first.publisher_source, "derived")

        # Check unmanaged app with ARP ID
        photoshop = apps[1]
        self.assertEqual(photoshop.name, "Adobe Photoshop 2021")
        self.assertEqual(photoshop.package_id, r"ARP\Machine\X86\PHSP_22_0")
        self.assertEqual(photoshop.version, "22.0.0.35")

        # Check last app: Zoom
        last = apps[-1]
        self.assertEqual(last.name, "Zoom")
        self.assertEqual(last.package_id, "Zoom.Zoom.EXE")
        self.assertEqual(last.version, "5.10.7 (6120)")

    def test_parse_truncated_names_with_ellipsis(self):
        """Verify handling of truncated package names ending with ... or unicode ellipsis."""
        fixture = (
            "Name                               Id                         Version\n"
            "---------------------------------------------------------------------\n"
            "Microsoft Visual C++ 2013...       Microsoft.VCRedist.2013    12.0.40664.0\n"
            "Intel Graphics Driver…             Intel.Graphics             31.0.101.4502\n"
        )
        apps = parse_winget_list_output(fixture)
        self.assertEqual(len(apps), 2)

        # ASCII ellipsis (...)
        self.assertEqual(apps[0].name, "Microsoft Visual C++ 2013")
        self.assertEqual(apps[0].raw_name, "Microsoft Visual C++ 2013...")
        self.assertEqual(apps[0].package_id, "Microsoft.VCRedist.2013")
        self.assertEqual(apps[0].version, "12.0.40664.0")

        # Unicode ellipsis (…)
        self.assertEqual(apps[1].name, "Intel Graphics Driver")
        self.assertEqual(apps[1].raw_name, "Intel Graphics Driver…")
        self.assertEqual(apps[1].package_id, "Intel.Graphics")

    def test_parse_row_with_no_package_id(self):
        """Verify handling of apps without package IDs (blank ID column)."""
        fixture = (
            "Name                               Id                         Version\n"
            "---------------------------------------------------------------------\n"
            "In-House Proprietary Tool                                     1.4.2\n"
            "Legacy Audio Driver                                           6.0.1\n"
        )
        apps = parse_winget_list_output(fixture)
        self.assertEqual(len(apps), 2)

        self.assertEqual(apps[0].name, "In-House Proprietary Tool")
        self.assertIsNone(apps[0].package_id)
        self.assertEqual(apps[0].version, "1.4.2")

        self.assertEqual(apps[1].name, "Legacy Audio Driver")
        self.assertIsNone(apps[1].package_id)
        self.assertEqual(apps[1].version, "6.0.1")

    def test_parse_wide_unicode_names(self):
        """Verify table parser handles wide/CJK characters without offset distortion."""
        fixture = (
            "Name                               Id                         Version\n"
            "---------------------------------------------------------------------\n"
            "日本語ツール (Japanese Tool)       Lang.Japanese              2.0.0\n"
            "Git for Windows                    Git.Git                    2.44.0\n"
        )
        apps = parse_winget_list_output(fixture)
        self.assertEqual(len(apps), 2)

        self.assertEqual(apps[0].name, "日本語ツール (Japanese Tool)")
        self.assertEqual(apps[0].package_id, "Lang.Japanese")
        self.assertEqual(apps[0].version, "2.0.0")

        self.assertEqual(apps[1].name, "Git for Windows")
        self.assertEqual(apps[1].package_id, "Git.Git")
        self.assertEqual(apps[1].version, "2.44.0")

    def test_parse_with_spinners_and_warnings(self):
        """Verify spinner characters and source open warnings are ignored cleanly."""
        fixture = (
            "\r\\\r|\r/\r-\n"
            "Failed when opening source(s); try 'winget source reset'\n"
            "⠋ Searching installed packages...\n"
            "Name                               Id                         Version\n"
            "---------------------------------------------------------------------\n"
            "7-Zip 24.09 (x64)                  7zip.7zip                  24.09\n"
            "1 packages found.\n"
        )
        apps = parse_winget_list_output(fixture)
        self.assertEqual(len(apps), 1)
        self.assertEqual(apps[0].name, "7-Zip 24.09 (x64)")
        self.assertEqual(apps[0].package_id, "7zip.7zip")

    def test_parse_empty_and_no_packages_found(self):
        """Verify empty string or zero packages message returns empty list."""
        self.assertEqual(parse_winget_list_output(""), [])
        self.assertEqual(parse_winget_list_output("   \n\r\n   "), [])

        no_pkgs = "No installed package found matching input criteria."
        self.assertEqual(parse_winget_list_output(no_pkgs), [])

        zero_pkgs = "0 packages found.\n"
        self.assertEqual(parse_winget_list_output(zero_pkgs), [])

    @patch("agent.scanner.winget.run_command")
    def test_list_installed_calls_winget_with_safe_flags(self, mock_cmd):
        mock_cmd.return_value = CommandResult(
            exit_code=0,
            output=(
                "Name               Id           Version\n"
                "---------------------------------------\n"
                "Git                Git.Git      2.44.0\n"
            ),
            error_output="",
            timed_out=False,
        )
        apps = list_installed(winget_cmd="winget.exe")
        self.assertEqual(len(apps), 1)
        self.assertEqual(apps[0].name, "Git")
        mock_cmd.assert_called_once_with(
            ["winget.exe", "list", "--disable-interactivity", "--accept-source-agreements"],
            timeout=45,
        )

    @patch("agent.scanner.winget.run_command")
    def test_list_installed_handles_hresult_no_packages(self, mock_cmd):
        # 0x8A15002B (-1978298325 in signed 32-bit int)
        mock_cmd.return_value = CommandResult(
            exit_code=-1978298325,
            output="",
            error_output="No installed package found matching input criteria.",
            timed_out=False,
        )
        apps = list_installed()
        self.assertEqual(apps, [])


if __name__ == "__main__":
    unittest.main()
