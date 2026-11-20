"""Unit tests for Windows registry scanner, filtering, deduplication, and error tolerance."""

import unittest
from unittest.mock import MagicMock

from agent.scanner.registry import (
    FakeRegistryBackend,
    WindowsRegistryBackend,
    scan_registry_installed,
    should_skip_registry_entry,
)


class TestRegistryFiltering(unittest.TestCase):
    """Test filtering rules for system components, patches, and invalid entries."""

    def test_skip_entries_with_no_display_name(self):
        self.assertTrue(should_skip_registry_entry({}))
        self.assertTrue(should_skip_registry_entry({"DisplayName": ""}))
        self.assertTrue(should_skip_registry_entry({"DisplayName": "   "}))
        self.assertTrue(should_skip_registry_entry({"DisplayName": None}))

    def test_skip_system_components(self):
        self.assertTrue(should_skip_registry_entry({"DisplayName": "Core OS Component", "SystemComponent": 1}))
        self.assertTrue(should_skip_registry_entry({"DisplayName": "Core OS Component", "SystemComponent": "1"}))
        self.assertTrue(should_skip_registry_entry({"DisplayName": "Core OS Component", "SystemComponent": True}))
        # SystemComponent 0 or None should not skip
        self.assertFalse(should_skip_registry_entry({"DisplayName": "Valid App", "SystemComponent": 0}))

    def test_skip_entries_with_parent_key(self):
        self.assertTrue(should_skip_registry_entry({"DisplayName": "Language Pack", "ParentKeyName": "MainSuite"}))
        self.assertFalse(should_skip_registry_entry({"DisplayName": "Standalone App", "ParentKeyName": None}))
        self.assertFalse(should_skip_registry_entry({"DisplayName": "Standalone App", "ParentKeyName": ""}))

    def test_skip_windows_updates_and_patches(self):
        self.assertTrue(should_skip_registry_entry({"DisplayName": "Security Update for Windows 11 (KB5034441)"}))
        self.assertTrue(should_skip_registry_entry({"DisplayName": "Update for Microsoft .NET Framework (KB500123)"}))
        self.assertTrue(should_skip_registry_entry({"DisplayName": "Hotfix for Windows (KB999999)"}))
        self.assertTrue(should_skip_registry_entry({"DisplayName": "KB1234567"}))
        self.assertTrue(should_skip_registry_entry({"DisplayName": "Office Component (KB4023057)"}))
        self.assertTrue(should_skip_registry_entry({"DisplayName": "Package", "ReleaseType": "Security Update"}))
        self.assertTrue(should_skip_registry_entry({"DisplayName": "Package", "ReleaseType": "Hotfix"}))

    def test_retain_legitimate_software(self):
        self.assertFalse(should_skip_registry_entry({
            "DisplayName": "VLC Media Player",
            "DisplayVersion": "3.0.20",
            "Publisher": "VideoLAN",
        }))


class TestScanRegistryInstalled(unittest.TestCase):
    """Test registry scanning, deduplication, and data mapping."""

    def test_scan_with_fake_backend(self):
        fake_entries = [
            {
                "DisplayName": "Git",
                "DisplayVersion": "2.44.0",
                "Publisher": "The Git Development Community",
                "InstallLocation": "C:\\Secret\\Path",  # should be ignored
            },
            {
                "DisplayName": "VLC media player",
                "DisplayVersion": "3.0.18",
                "Publisher": "VideoLAN",
            },
            {
                # Duplicate in 32-bit hive
                "DisplayName": "VLC media player",
                "DisplayVersion": "3.0.18",
                "Publisher": "VideoLAN",
            },
            {
                # System component (must be skipped)
                "DisplayName": "Windows Diagnostic Tool",
                "SystemComponent": 1,
            },
            {
                # Security patch (must be skipped)
                "DisplayName": "Security Update for Windows (KB5012345)",
            },
        ]
        backend = FakeRegistryBackend(entries=fake_entries, warnings=["Key missing: HKCU\\..."])
        apps, warnings = scan_registry_installed(backend=backend)

        self.assertEqual(len(apps), 2)
        self.assertEqual(len(warnings), 1)

        # Check Git
        git_app = apps[0]
        self.assertEqual(git_app.name, "Git")
        self.assertEqual(git_app.version, "2.44.0")
        self.assertEqual(git_app.publisher, "The Git Development Community")
        self.assertEqual(git_app.source, "registry")
        self.assertEqual(git_app.publisher_source, "registry")
        self.assertIsNone(git_app.package_id)

        # Ensure no forbidden fields (file paths or install locations)
        d = git_app.to_dict()
        self.assertNotIn("InstallLocation", d)

        # Check VLC
        vlc_app = apps[1]
        self.assertEqual(vlc_app.name, "VLC media player")
        self.assertEqual(vlc_app.publisher, "VideoLAN")


class TestWindowsRegistryBackendErrors(unittest.TestCase):
    """Test resilience against missing keys, permission errors, and malformed values."""

    def test_backend_gracefully_handles_missing_winreg(self):
        backend = WindowsRegistryBackend(winreg_module=None)
        entries, warnings = backend.read_all_uninstall_entries()
        self.assertEqual(entries, [])
        self.assertEqual(len(warnings), 1)
        self.assertIn("winreg module is not available", warnings[0])

    def test_backend_handles_missing_keys_and_permission_errors(self):
        mock_winreg = MagicMock()
        mock_winreg.HKEY_LOCAL_MACHINE = 0x80000002
        mock_winreg.HKEY_CURRENT_USER = 0x80000001
        mock_winreg.KEY_READ = 0x20019
        mock_winreg.KEY_WOW64_64KEY = 0x0100
        mock_winreg.KEY_WOW64_32KEY = 0x0200

        # Simulate OpenKey: first hive FileNotFoundError, second PermissionError, third succeeds
        mock_handle = MagicMock()
        mock_handle.__enter__.return_value = mock_handle
        mock_handle.__exit__.return_value = None

        mock_subhandle = MagicMock()
        mock_subhandle.__enter__.return_value = mock_subhandle
        mock_subhandle.__exit__.return_value = None

        mock_winreg.OpenKey.side_effect = [
            FileNotFoundError(2, "The system cannot find the file specified"),
            PermissionError(5, "Access is denied"),
            mock_handle,       # OpenKey HKCU
            mock_subhandle,    # OpenKey subkey
        ]

        mock_winreg.QueryInfoKey.return_value = (1, 0, 0)
        mock_winreg.EnumKey.return_value = "TestAppKey"
        mock_winreg.QueryValueEx.side_effect = [
            ("Test Desktop App", 1),  # DisplayName
            ("1.2.3", 1),             # DisplayVersion
            ("Test Corp", 1),         # Publisher
            FileNotFoundError(),      # SystemComponent
            FileNotFoundError(),      # ParentKeyName
            FileNotFoundError(),      # ReleaseType
        ]

        backend = WindowsRegistryBackend(winreg_module=mock_winreg)
        entries, warnings = backend.read_all_uninstall_entries()

        # Should report warnings for the 2 failed hives, and collect 1 entry from HKCU
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["DisplayName"], "Test Desktop App")
        self.assertEqual(entries[0]["DisplayVersion"], "1.2.3")
        self.assertEqual(entries[0]["Publisher"], "Test Corp")

        self.assertEqual(len(warnings), 2)
        self.assertTrue(any("Registry key not found" in w for w in warnings))
        self.assertTrue(any("Permission denied" in w for w in warnings))


if __name__ == "__main__":
    unittest.main()
