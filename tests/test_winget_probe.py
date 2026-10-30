"""
Unit tests for tools/winget_probe.py
Verifies parsing of winget list and winget upgrade outputs under various formatting conditions.
"""

import unittest
import sys
import os

# Add tools directory to path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'tools')))

from winget_probe import parse_winget_table, clean_ansi, NO_APPLICATIONS_FOUND_CODES


class TestWinGetProbe(unittest.TestCase):

    def test_clean_ansi(self):
        colored_text = "\x1b[31mRed Text\x1b[0m and \x1b[1mBold\x1b[0m"
        self.assertEqual(clean_ansi(colored_text), "Red Text and Bold")

    def test_parse_winget_list_output(self):
        sample_output = """
Name                                     Id                               Version          Available    Source
----------------------------------------------------------------------------------------------------------------
Git                                      Git.Git                          2.44.0           2.45.0       winget
Python 3.14.0 (64-bit)                   Python.Python.3.14               3.14.0                        winget
Visual Studio Code                       Microsoft.VisualStudioCode       1.88.1           1.89.0       winget
Unmanaged Tool Suite                                                      1.2.0
"""
        parsed = parse_winget_table(sample_output)
        self.assertEqual(len(parsed), 4)

        # Check Git row
        self.assertEqual(parsed[0]["name"], "Git")
        self.assertEqual(parsed[0]["id"], "Git.Git")
        self.assertEqual(parsed[0]["version"], "2.44.0")
        self.assertEqual(parsed[0]["available_version"], "2.45.0")
        self.assertEqual(parsed[0]["source"], "winget")

        # Check Python row (no update available)
        self.assertEqual(parsed[1]["name"], "Python 3.14.0 (64-bit)")
        self.assertEqual(parsed[1]["id"], "Python.Python.3.14")
        self.assertEqual(parsed[1]["version"], "3.14.0")
        self.assertIsNone(parsed[1]["available_version"])
        self.assertEqual(parsed[1]["source"], "winget")

        # Check Unmanaged app without ID
        self.assertEqual(parsed[3]["name"], "Unmanaged Tool Suite")
        self.assertIsNone(parsed[3]["id"])
        self.assertEqual(parsed[3]["version"], "1.2.0")
        self.assertIsNone(parsed[3]["source"])

    def test_parse_winget_upgrade_output_with_summary(self):
        sample_output = """
Name                          Id                               Version       Available     Source
---------------------------------------------------------------------------------------------------
Google Chrome                 Google.Chrome                    124.0.6367.60 124.0.6367.78 winget
Mozilla Firefox               Mozilla.Firefox                  125.0.1       125.0.2       winget
2 upgrades available.
"""
        parsed = parse_winget_table(sample_output)
        self.assertEqual(len(parsed), 2)
        self.assertEqual(parsed[0]["name"], "Google Chrome")
        self.assertEqual(parsed[0]["id"], "Google.Chrome")
        self.assertEqual(parsed[0]["version"], "124.0.6367.60")
        self.assertEqual(parsed[0]["available_version"], "124.0.6367.78")

        self.assertEqual(parsed[1]["name"], "Mozilla Firefox")
        self.assertEqual(parsed[1]["id"], "Mozilla.Firefox")

    def test_parse_empty_or_invalid_output(self):
        self.assertEqual(parse_winget_table(""), [])
        self.assertEqual(parse_winget_table("No packages found"), [])
        self.assertEqual(parse_winget_table("Random console message\nAnother line"), [])

    def test_no_applications_found_exit_codes(self):
        self.assertIn(-1978298325, NO_APPLICATIONS_FOUND_CODES)
        self.assertIn(2316632107, NO_APPLICATIONS_FOUND_CODES)

    def test_parse_real_fixtures(self):
        fixture_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), 'fixtures', 'winget'))
        list_file = os.path.join(fixture_dir, 'list.txt')
        upgrade_file = os.path.join(fixture_dir, 'upgrade.txt')

        if os.path.exists(list_file):
            with open(list_file, 'r', encoding='utf-8', errors='replace') as f:
                content = f.read()
            items = parse_winget_table(content)
            self.assertGreater(len(items), 50, "Should parse at least 50 installed applications from real list.txt")
            # Verify 7-Zip is present
            seven_zip = next((item for item in items if item["id"] == "7zip.7zip"), None)
            self.assertIsNotNone(seven_zip)
            self.assertEqual(seven_zip["source"], "winget")

        if os.path.exists(upgrade_file):
            with open(upgrade_file, 'r', encoding='utf-8', errors='replace') as f:
                content = f.read()
            upgrades = parse_winget_table(content)
            self.assertGreater(len(upgrades), 20, "Should parse available upgrades from real upgrade.txt")
            # Verify Git is detected
            git_up = next((item for item in upgrades if item["id"] == "Git.Git"), None)
            self.assertIsNotNone(git_up)
            self.assertTrue(git_up["available_version"])


if __name__ == '__main__':
    unittest.main()
