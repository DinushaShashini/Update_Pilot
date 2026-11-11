"""Unit tests for package ID parsing, publisher derivation, and winget show enrichment."""

import unittest
from unittest.mock import MagicMock, patch

from agent.scanner.models import InstalledApp
from agent.scanner.publisher import (
    derive_publisher_from_id,
    enrich_apps_with_winget_show,
    extract_publisher_from_winget_show,
    get_publisher_with_winget_show,
    is_standard_winget_id,
)
from agent.scanner.runner import CommandResult
from agent.scanner.winget import list_installed, parse_winget_list_output


class TestPublisherExtraction(unittest.TestCase):
    """Test package ID classification and publisher derivation."""

    def test_is_standard_winget_id(self):
        self.assertTrue(is_standard_winget_id("Git.Git"))
        self.assertTrue(is_standard_winget_id("Microsoft.VisualStudioCode"))
        self.assertTrue(is_standard_winget_id("7zip.7zip"))
        self.assertTrue(is_standard_winget_id("Python.Python.3.14"))

        # Non-standard / synthetic IDs
        self.assertFalse(is_standard_winget_id(r"ARP\Machine\X86\PHSP_22_0"))
        self.assertFalse(is_standard_winget_id(r"MSIX\Microsoft.XboxGamingOverlay"))
        self.assertFalse(is_standard_winget_id("{FA325AF9-171E-4615-B301-B049DF1F78F1}"))
        self.assertFalse(is_standard_winget_id("SingleWordNoDot"))
        self.assertFalse(is_standard_winget_id(""))
        self.assertFalse(is_standard_winget_id(None))

    def test_derive_publisher_from_id(self):
        # Valid standard IDs
        pub, src = derive_publisher_from_id("Git.Git")
        self.assertEqual(pub, "Git")
        self.assertEqual(src, "derived")

        pub, src = derive_publisher_from_id("Microsoft.VisualStudioCode")
        self.assertEqual(pub, "Microsoft")
        self.assertEqual(src, "derived")

        pub, src = derive_publisher_from_id("7zip.7zip")
        self.assertEqual(pub, "7zip")
        self.assertEqual(src, "derived")

        # Unmanaged / ARP IDs should not derive
        pub, src = derive_publisher_from_id(r"ARP\Machine\X64\Android Studio")
        self.assertIsNone(pub)
        self.assertIsNone(src)

        pub, src = derive_publisher_from_id(None)
        self.assertIsNone(pub)
        self.assertIsNone(src)

    def test_extract_publisher_from_winget_show(self):
        sample_output = (
            "Found Git [Git.Git]\n"
            "Version: 2.45.0\n"
            "Publisher: The Git Development Community\n"
            "Publisher Url: https://git-scm.com/\n"
            "Author: Junio C Hamano\n"
            "Description: Fast, scalable, distributed revision control system\n"
        )
        pub = extract_publisher_from_winget_show(sample_output)
        self.assertEqual(pub, "The Git Development Community")

    def test_extract_publisher_missing_field(self):
        output = "Found Package [Vendor.Tool]\nVersion: 1.0.0\nAuthor: Some Author\n"
        self.assertIsNone(extract_publisher_from_winget_show(output))


class TestPublisherEnrichment(unittest.TestCase):
    """Test enrichment via winget show, limits, and failure tolerance."""

    @patch("agent.scanner.publisher.run_command")
    def test_get_publisher_with_winget_show_success(self, mock_run):
        mock_run.return_value = CommandResult(
            exit_code=0,
            output="Publisher: Google LLC\nVersion: 124.0.0\n",
            error_output="",
            timed_out=False,
        )

        pub = get_publisher_with_winget_show("Google.Chrome", winget_cmd="winget.exe")
        self.assertEqual(pub, "Google LLC")
        mock_run.assert_called_once_with(
            [
                "winget.exe",
                "show",
                "--id",
                "Google.Chrome",
                "--exact",
                "--disable-interactivity",
                "--accept-source-agreements",
            ],
            timeout=10,
        )

    @patch("agent.scanner.publisher.run_command")
    def test_get_publisher_with_winget_show_failure_returns_none(self, mock_run):
        mock_run.return_value = CommandResult(
            exit_code=1,
            output="",
            error_output="Package not found",
            timed_out=False,
        )
        pub = get_publisher_with_winget_show("Nonexistent.Package")
        self.assertIsNone(pub)

    @patch("agent.scanner.publisher.run_command")
    def test_get_publisher_with_winget_show_timeout_returns_none(self, mock_run):
        mock_run.return_value = CommandResult(
            exit_code=-1,
            output="",
            error_output="Timed out",
            timed_out=True,
        )
        pub = get_publisher_with_winget_show("Hanging.Package")
        self.assertIsNone(pub)

    @patch("agent.scanner.publisher.get_publisher_with_winget_show")
    def test_enrich_apps_bounded_by_max_enrich_limit(self, mock_get_pub):
        mock_get_pub.side_effect = [
            "Publisher One",
            "Publisher Two",
            "Publisher Three",
        ]

        apps = [
            InstalledApp(name="App 1", version="1.0", package_id="Vendor1.App1", publisher="Vendor1", publisher_source="derived"),
            InstalledApp(name="App 2", version="1.0", package_id="Vendor2.App2", publisher="Vendor2", publisher_source="derived"),
            InstalledApp(name="App 3", version="1.0", package_id="Vendor3.App3", publisher="Vendor3", publisher_source="derived"),
            InstalledApp(name="App 4", version="1.0", package_id="Vendor4.App4", publisher="Vendor4", publisher_source="derived"),
        ]

        # Limit to 2 enrichments
        enriched = enrich_apps_with_winget_show(apps, max_enrich=2)

        self.assertEqual(enriched[0].publisher, "Publisher One")
        self.assertEqual(enriched[0].publisher_source, "winget_show")

        self.assertEqual(enriched[1].publisher, "Publisher Two")
        self.assertEqual(enriched[1].publisher_source, "winget_show")

        # 3rd and 4th must remain untouched as derived
        self.assertEqual(enriched[2].publisher, "Vendor3")
        self.assertEqual(enriched[2].publisher_source, "derived")

        self.assertEqual(enriched[3].publisher, "Vendor4")
        self.assertEqual(enriched[3].publisher_source, "derived")

        self.assertEqual(mock_get_pub.call_count, 2)

    @patch("agent.scanner.publisher.get_publisher_with_winget_show")
    def test_enrich_apps_default_off_makes_zero_calls(self, mock_get_pub):
        apps = [
            InstalledApp(name="App 1", version="1.0", package_id="Vendor1.App1", publisher="Vendor1", publisher_source="derived"),
        ]
        enrich_apps_with_winget_show(apps, max_enrich=0)
        mock_get_pub.assert_not_called()

    @patch("agent.scanner.publisher.get_publisher_with_winget_show")
    def test_enrich_apps_preserves_derived_on_show_failure(self, mock_get_pub):
        mock_get_pub.return_value = None  # winget show failed

        apps = [
            InstalledApp(name="Git", version="2.44", package_id="Git.Git", publisher="Git", publisher_source="derived"),
        ]
        enriched = enrich_apps_with_winget_show(apps, max_enrich=1)

        self.assertEqual(enriched[0].publisher, "Git")
        self.assertEqual(enriched[0].publisher_source, "derived")


class TestTableParserPublisherIntegration(unittest.TestCase):
    """Test that parse_winget_list_output automatically populates derived publishers."""

    def test_table_parser_derives_publisher(self):
        fixture = (
            "Name               Id           Version\n"
            "---------------------------------------\n"
            "Git                Git.Git      2.44.0\n"
            "Proprietary App                 1.0.0\n"
        )
        apps = parse_winget_list_output(fixture)
        self.assertEqual(len(apps), 2)

        self.assertEqual(apps[0].package_id, "Git.Git")
        self.assertEqual(apps[0].publisher, "Git")
        self.assertEqual(apps[0].publisher_source, "derived")

        self.assertIsNone(apps[1].package_id)
        self.assertIsNone(apps[1].publisher)
        self.assertIsNone(apps[1].publisher_source)


if __name__ == "__main__":
    unittest.main()
