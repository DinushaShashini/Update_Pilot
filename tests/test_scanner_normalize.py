"""Unit tests for inventory normalization, comparison keys, merging and deduplication."""

import unittest

from agent.scanner.models import InstalledApp
from agent.scanner.normalize import (
    clean_text,
    make_comparison_name_key,
    make_comparison_version_key,
    merge_and_deduplicate_apps,
    normalize_app,
    normalize_version,
)


class TestTextAndVersionNormalization(unittest.TestCase):
    """Test string trimming, whitespace collapsing, control characters, and length caps."""

    def test_clean_text_whitespace_and_tabs(self):
        self.assertEqual(clean_text("   Git   for   Windows   "), "Git for Windows")
        self.assertEqual(clean_text("Node.js\t\t\n  Development   Kit"), "Node.js Development Kit")

    def test_clean_text_strips_control_characters(self):
        # NUL, BEL, BS, ESC
        raw = "Visual\x00Studio\x07Code\x08\x1b"
        self.assertEqual(clean_text(raw), "VisualStudioCode")

    def test_clean_text_preserves_unicode(self):
        text = "Intel® Graphics 日本語ツール (x64)"
        self.assertEqual(clean_text(text), "Intel® Graphics 日本語ツール (x64)")

    def test_clean_text_caps_long_values(self):
        long_str = "A" * 500
        cleaned = clean_text(long_str, max_len=256)
        self.assertEqual(len(cleaned), 256)
        self.assertEqual(cleaned, "A" * 256)

    def test_clean_text_none_and_empty(self):
        self.assertIsNone(clean_text(None))
        self.assertIsNone(clean_text(""))
        self.assertIsNone(clean_text("    \t  \n  "))

    def test_normalize_version_defaults_to_unknown(self):
        self.assertEqual(normalize_version(""), "Unknown")
        self.assertEqual(normalize_version(None), "Unknown")
        self.assertEqual(normalize_version("   "), "Unknown")
        self.assertEqual(normalize_version("none"), "Unknown")
        self.assertEqual(normalize_version("UNKNOWN"), "Unknown")
        self.assertEqual(normalize_version("null"), "Unknown")
        self.assertEqual(normalize_version(" 2.44.0 "), "2.44.0")

    def test_normalize_app(self):
        app = InstalledApp(
            name="  Git for Windows  ",
            version="  2.44.0\x00 ",
            publisher=" Junio Hamano ",
            package_id=" Git.Git ",
            source="winget",
        )
        norm = normalize_app(app)
        self.assertEqual(norm.name, "Git for Windows")
        self.assertEqual(norm.version, "2.44.0")
        self.assertEqual(norm.publisher, "Junio Hamano")
        self.assertEqual(norm.package_id, "Git.Git")


class TestComparisonKeys(unittest.TestCase):
    """Test generating comparison keys that ignore case, punctuation and architecture."""

    def test_make_comparison_name_key_strips_arch_markers(self):
        key1 = make_comparison_name_key("Visual Studio Code (x64)")
        key2 = make_comparison_name_key("Visual Studio Code 64-bit")
        key3 = make_comparison_name_key("visual studio code")
        self.assertEqual(key1, key2)
        self.assertEqual(key2, key3)
        self.assertEqual(key1, "visual studio code")

    def test_make_comparison_name_key_strips_punctuation(self):
        key = make_comparison_name_key("7-Zip [x64] :: Archiver!")
        self.assertEqual(key, "7 zip archiver")

    def test_make_comparison_version_key(self):
        self.assertEqual(make_comparison_version_key("2.44.0-rc1"), "2.44.0rc1")
        self.assertEqual(make_comparison_version_key("v1.2.3"), "v1.2.3")
        self.assertEqual(make_comparison_version_key("Unknown"), "")


class TestMergeAndDeduplicate(unittest.TestCase):
    """Test merging WinGet and registry inventory, priority rules, deduplication, and ordering."""

    def test_merge_by_package_id_prefers_winget_id_and_registry_publisher(self):
        winget_apps = [
            InstalledApp(
                name="Git",
                version="2.44.0",
                publisher="Git",
                package_id="Git.Git",
                source="winget",
                publisher_source="derived",
            )
        ]
        registry_apps = [
            InstalledApp(
                name="Git for Windows",
                version="2.44.0",
                publisher="The Git Development Community",
                package_id="Git.Git",
                source="registry",
                publisher_source="registry",
            )
        ]

        merged = merge_and_deduplicate_apps(winget_apps, registry_apps)
        self.assertEqual(len(merged), 1)

        app = merged[0]
        self.assertEqual(app.name, "Git")
        self.assertEqual(app.version, "2.44.0")
        # Preferred WinGet ID
        self.assertEqual(app.package_id, "Git.Git")
        # Preferred Registry Publisher
        self.assertEqual(app.publisher, "The Git Development Community")
        self.assertEqual(app.publisher_source, "registry")
        # Merged source is 'both'
        self.assertEqual(app.source, "both")

    def test_merge_by_name_and_version_when_no_package_id_in_registry(self):
        winget_apps = [
            InstalledApp(
                name="Visual Studio Code (x64)",
                version="1.88.1",
                publisher="Microsoft",
                package_id="Microsoft.VisualStudioCode",
                source="winget",
                publisher_source="derived",
            )
        ]
        registry_apps = [
            InstalledApp(
                name="Visual Studio Code",
                version="1.88.1",
                publisher="Microsoft Corporation",
                package_id=None,
                source="registry",
                publisher_source="registry",
            )
        ]

        merged = merge_and_deduplicate_apps(winget_apps, registry_apps)
        self.assertEqual(len(merged), 1)

        app = merged[0]
        self.assertEqual(app.package_id, "Microsoft.VisualStudioCode")
        self.assertEqual(app.publisher, "Microsoft Corporation")
        self.assertEqual(app.publisher_source, "registry")
        self.assertEqual(app.source, "both")

    def test_unmatched_apps_retain_original_source(self):
        winget_apps = [
            InstalledApp(
                name="7-Zip",
                version="24.09",
                package_id="7zip.7zip",
                source="winget",
            )
        ]
        registry_apps = [
            InstalledApp(
                name="Legacy In-House Utility",
                version="1.0.0",
                publisher="Internal Org",
                package_id=None,
                source="registry",
                publisher_source="registry",
            )
        ]

        merged = merge_and_deduplicate_apps(winget_apps, registry_apps)
        self.assertEqual(len(merged), 2)

        self.assertEqual(merged[0].name, "7-Zip")
        self.assertEqual(merged[0].source, "winget")

        self.assertEqual(merged[1].name, "Legacy In-House Utility")
        self.assertEqual(merged[1].source, "registry")

    def test_deduplicates_identical_registry_entries(self):
        registry_apps = [
            InstalledApp(name="Node.js (x64)", version="20.11.0", source="registry"),
            InstalledApp(name="Node.js", version="20.11.0", source="registry"),
        ]
        merged = merge_and_deduplicate_apps([], registry_apps)
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0].version, "20.11.0")

    def test_results_are_sorted_alphabetically_by_name(self):
        apps = [
            InstalledApp(name="Zoom", version="5.10", source="winget"),
            InstalledApp(name="7-Zip", version="24.09", source="winget"),
            InstalledApp(name="apache tomcat", version="9.0", source="registry"),
            InstalledApp(name="Git", version="2.44", source="winget"),
        ]
        merged = merge_and_deduplicate_apps(apps, [])
        names = [a.name for a in merged]
        self.assertEqual(names, ["7-Zip", "apache tomcat", "Git", "Zoom"])


if __name__ == "__main__":
    unittest.main()
