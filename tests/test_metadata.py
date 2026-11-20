"""Unit tests for agent package metadata collection via winget show."""

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock, patch

from agent.cli import execute_get_metadata, main
from agent.metadata import (
    MAX_PACKAGE_IDS_PER_JOB,
    get_package_metadata,
    get_single_package_metadata,
    is_valid_package_id,
    parse_winget_show_output,
)
from agent.scanner.models import GetPackageMetadataResult, PackageMetadata
from agent.scanner.runner import CommandResult

SAMPLE_WINGET_SHOW_GIT = """Found Git [Git.Git]
Version: 2.50.0.2
Publisher: The Git Development Community
Publisher Url: https://git-scm.com/
Publisher Support Url: https://git-scm.com/community
Author: Junio C Hamano
Moniker: git
Description: Fast, scalable, distributed revision control system
Homepage: https://git-scm.com/
License: GPL-2.0
License Url: https://raw.githubusercontent.com/git/git/master/COPYING
Release Notes:
  * Updates for security vulnerabilities (CVE-2024-32002, CVE-2024-32004)
  * Performance optimizations for rebase and fetch
Release Notes Url: https://raw.githubusercontent.com/git/git/master/Documentation/RelNotes/2.50.0.txt
Purchase Url: https://git-scm.com/
Installer:
  Installer Type: inno
  Installer Url: https://github.com/git-for-windows/git/releases/download/v2.50.0.windows.2/Git-2.50.0.2-64-bit.exe
  Installer SHA256: 7f7634f19b8...
"""

SAMPLE_WINGET_SHOW_7ZIP_NO_RELEASE_NOTES = """Found 7-Zip [7zip.7zip]
Version: 24.08
Publisher: Igor Pavlov
Publisher Url: https://www.7-zip.org/
Description: 7-Zip is a file archiver with a high compression ratio.
Homepage: https://www.7-zip.org/
License: GNU LGPL
Installer:
  Installer Type: nullsoft
  Installer Url: https://www.7-zip.org/a/7z2408-x64.exe
"""

SAMPLE_WINGET_SHOW_INLINE_RELEASE_NOTES = """Found Tool [Vendor.Tool]
Version: 1.2.3
Publisher: Tool Author
Homepage: https://example.com/tool
Release Notes: Bug fixes and performance improvements in version 1.2.3.
Release Notes Url: https://example.com/notes
Installer Type: msi
"""


class TestPackageIdValidation(unittest.TestCase):
    """Test validation of WinGet package identifier format."""

    def test_valid_package_ids(self):
        self.assertTrue(is_valid_package_id("Git.Git"))
        self.assertTrue(is_valid_package_id("7zip.7zip"))
        self.assertTrue(is_valid_package_id("Microsoft.VisualStudioCode"))
        self.assertTrue(is_valid_package_id("Python.Python.3.14"))
        self.assertTrue(is_valid_package_id("Vendor_Name.Product-1"))

    def test_invalid_package_ids(self):
        # Empty or non-string
        self.assertFalse(is_valid_package_id(""))
        self.assertFalse(is_valid_package_id("   "))
        self.assertFalse(is_valid_package_id(None))

        # Single token without separator dot
        self.assertFalse(is_valid_package_id("SingleToken"))

        # Dangerous shell characters or spaces
        self.assertFalse(is_valid_package_id("Git.Git; calc.exe"))
        self.assertFalse(is_valid_package_id("Git.Git | rm -rf"))
        self.assertFalse(is_valid_package_id("Git.Git & echo 1"))
        self.assertFalse(is_valid_package_id("Git.Git && dir"))
        self.assertFalse(is_valid_package_id("Git.Git`whoami`"))
        self.assertFalse(is_valid_package_id("Git .Git"))

        # Non-WinGet system prefixes or GUIDs
        self.assertFalse(is_valid_package_id(r"ARP\Machine\X64\App"))
        self.assertFalse(is_valid_package_id("{FA325AF9-171E-4615-B301-B049DF1F78F1}"))

        # Oversized ID
        self.assertFalse(is_valid_package_id("A" * 257 + ".App"))


class TestWingetShowParsing(unittest.TestCase):
    """Test extraction of metadata fields and release notes from winget show output."""

    def test_parse_complete_metadata(self):
        meta = parse_winget_show_output(SAMPLE_WINGET_SHOW_GIT, package_id="Git.Git")
        self.assertEqual(meta.package_id, "Git.Git")
        self.assertEqual(meta.version, "2.50.0.2")
        self.assertEqual(meta.publisher, "The Git Development Community")
        self.assertEqual(meta.publisher_url, "https://git-scm.com/")
        self.assertEqual(meta.homepage_url, "https://git-scm.com/")
        self.assertEqual(
            meta.release_notes_url,
            "https://raw.githubusercontent.com/git/git/master/Documentation/RelNotes/2.50.0.txt",
        )
        self.assertIn("CVE-2024-32002", meta.release_notes_text or "")
        self.assertIn("Performance optimizations", meta.release_notes_text or "")
        self.assertEqual(meta.installer_type, "inno")
        self.assertEqual(meta.fetch_status, "success")
        self.assertIsNone(meta.error)

    def test_parse_missing_release_notes(self):
        meta = parse_winget_show_output(SAMPLE_WINGET_SHOW_7ZIP_NO_RELEASE_NOTES, package_id="7zip.7zip")
        self.assertEqual(meta.package_id, "7zip.7zip")
        self.assertEqual(meta.version, "24.08")
        self.assertEqual(meta.publisher, "Igor Pavlov")
        self.assertEqual(meta.homepage_url, "https://www.7-zip.org/")
        self.assertEqual(meta.publisher_url, "https://www.7-zip.org/")
        self.assertIsNone(meta.release_notes_url)
        self.assertIsNone(meta.release_notes_text)
        self.assertEqual(meta.installer_type, "nullsoft")
        self.assertEqual(meta.fetch_status, "success")

    def test_parse_inline_release_notes(self):
        meta = parse_winget_show_output(SAMPLE_WINGET_SHOW_INLINE_RELEASE_NOTES, package_id="Vendor.Tool")
        self.assertEqual(meta.package_id, "Vendor.Tool")
        self.assertEqual(meta.version, "1.2.3")
        self.assertEqual(meta.publisher, "Tool Author")
        self.assertEqual(meta.homepage_url, "https://example.com/tool")
        self.assertEqual(meta.release_notes_url, "https://example.com/notes")
        self.assertEqual(meta.release_notes_text, "Bug fixes and performance improvements in version 1.2.3.")
        self.assertEqual(meta.installer_type, "msi")

    def test_parse_empty_or_minimal_output(self):
        output = "Found Package [Vendor.App]\n"
        meta = parse_winget_show_output(output, package_id="Vendor.App")
        self.assertEqual(meta.package_id, "Vendor.App")
        self.assertIsNone(meta.version)
        self.assertIsNone(meta.publisher)
        self.assertIsNone(meta.homepage_url)
        self.assertIsNone(meta.release_notes_url)
        self.assertIsNone(meta.release_notes_text)
        self.assertIsNone(meta.installer_type)


class TestSinglePackageMetadata(unittest.TestCase):
    """Test single package execution, error handling, and timeouts."""

    def test_invalid_package_id_returns_error_without_running_command(self):
        meta = get_single_package_metadata("InvalidSingleToken")
        self.assertEqual(meta.fetch_status, "error")
        self.assertIn("Invalid package ID format", meta.error or "")

    @patch("agent.metadata.run_command")
    def test_success_execution(self, mock_run):
        mock_run.return_value = CommandResult(
            exit_code=0,
            output=SAMPLE_WINGET_SHOW_GIT,
            error_output="",
            timed_out=False,
        )
        meta = get_single_package_metadata("Git.Git")
        self.assertEqual(meta.fetch_status, "success")
        self.assertEqual(meta.version, "2.50.0.2")
        mock_run.assert_called_once_with(
            ["winget", "show", "--id", "Git.Git", "--exact", "--disable-interactivity", "--accept-source-agreements"],
            timeout=15,
        )

    @patch("agent.metadata.run_command")
    def test_timeout_execution(self, mock_run):
        mock_run.return_value = CommandResult(
            exit_code=-1,
            output="",
            error_output="Execution timed out",
            timed_out=True,
        )
        meta = get_single_package_metadata("Slow.Package", timeout=5)
        self.assertEqual(meta.fetch_status, "timeout")
        self.assertIn("timed out after 5s", meta.error or "")

    @patch("agent.metadata.run_command")
    def test_not_found_execution(self, mock_run):
        mock_run.return_value = CommandResult(
            exit_code=1,
            output="",
            error_output="No package found matching input criteria.",
            timed_out=False,
        )
        meta = get_single_package_metadata("Missing.Package")
        self.assertEqual(meta.fetch_status, "not_found")
        self.assertIn("code 1", meta.error or "")


class TestGetPackageMetadataBatch(unittest.TestCase):
    """Test batch metadata retrieval, capping to 20 IDs, and error resilience."""

    @patch("agent.metadata.get_single_package_metadata")
    def test_caps_package_ids_at_20(self, mock_single):
        mock_single.return_value = PackageMetadata(package_id="Test.App", fetch_status="success")

        ids = [f"Vendor.App{i}" for i in range(25)]
        res = get_package_metadata(ids)

        self.assertEqual(len(res.packages), MAX_PACKAGE_IDS_PER_JOB)
        self.assertEqual(mock_single.call_count, MAX_PACKAGE_IDS_PER_JOB)
        self.assertTrue(any("capped at 20" in w for w in res.warnings))

    @patch("agent.metadata.get_single_package_metadata")
    def test_error_isolation_between_packages(self, mock_single):
        def side_effect(package_id, **kwargs):
            if package_id == "Failing.App":
                return PackageMetadata(package_id=package_id, fetch_status="error", error="Fail")
            if package_id == "Timeout.App":
                return PackageMetadata(package_id=package_id, fetch_status="timeout", error="Timeout")
            return PackageMetadata(package_id=package_id, fetch_status="success", version="1.0.0")

        mock_single.side_effect = side_effect

        res = get_package_metadata(["Good.App1", "Failing.App", "Timeout.App", "Good.App2"])

        self.assertEqual(len(res.packages), 4)
        self.assertEqual(res.packages[0].fetch_status, "success")
        self.assertEqual(res.packages[1].fetch_status, "error")
        self.assertEqual(res.packages[2].fetch_status, "timeout")
        self.assertEqual(res.packages[3].fetch_status, "success")
        self.assertEqual(len(res.warnings), 2)


class TestCliMetadata(unittest.TestCase):
    """Test CLI metadata command execution and formatting."""

    @patch("agent.cli.get_package_metadata")
    def test_cli_execute_metadata_json(self, mock_meta):
        mock_meta.return_value = GetPackageMetadataResult(
            packages=[
                PackageMetadata(
                    package_id="Git.Git",
                    version="2.50.0.2",
                    publisher="The Git Development Community",
                    release_notes_url="https://git-scm.com/relnotes",
                    fetch_status="success",
                )
            ]
        )

        with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as f:
            temp_path = Path(f.name)

        try:
            code = execute_get_metadata(
                package_ids=["Git.Git"],
                output_json=False,
                output_file=temp_path,
            )
            self.assertEqual(code, 0)
            self.assertTrue(temp_path.exists())
            with open(temp_path, "r", encoding="utf-8") as rf:
                saved = json.load(rf)
                self.assertEqual(len(saved["packages"]), 1)
                self.assertEqual(saved["packages"][0]["package_id"], "Git.Git")
        finally:
            if temp_path.exists():
                temp_path.unlink()

    @patch("agent.cli.get_package_metadata")
    def test_main_cli_dispatch_metadata(self, mock_meta):
        mock_meta.return_value = GetPackageMetadataResult(
            packages=[PackageMetadata(package_id="Git.Git", fetch_status="success")]
        )
        code = main(["metadata", "--id", "Git.Git", "--json"])
        self.assertEqual(code, 0)
        mock_meta.assert_called_once_with(package_ids=["Git.Git"])


if __name__ == "__main__":
    unittest.main()
