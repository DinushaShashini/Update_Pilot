"""Snapshot tests verifying the full scan pipeline, payload schema validation, and output fidelity."""

import json
from pathlib import Path
import unittest
from unittest.mock import patch

import jsonschema

from agent.scanner.models import InstalledApp, ScanResult
from agent.scanner.payload import (
    SCAN_PAYLOAD_SCHEMA,
    convert_scan_result_to_api_payload,
    validate_scan_payload,
)
from agent.scanner.registry import FakeRegistryBackend
from agent.scanner.scan import scan_inventory
from agent.scanner.winget import parse_winget_list_output

FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures" / "winget"
REAL_LIST_FIXTURE_PATH = FIXTURES_DIR / "list.txt"


class TestScanPayloadValidation(unittest.TestCase):
    """Test schema validation and conversion of ScanResult to API contract."""

    def test_validate_valid_payload(self):
        valid_payload = {
            "exit_code": 0,
            "discovered_packages": [
                {
                    "name": "Git for Windows",
                    "package_id": "Git.Git",
                    "installed_version": "2.50.0.2",
                    "available_version": None,
                    "source": "winget",
                    "is_managed": True,
                }
            ],
            "available_upgrades": [],
            "raw_stderr": "",
        }
        # Should not raise
        validate_scan_payload(valid_payload)

    def test_validate_invalid_payload_missing_required_fields(self):
        invalid_payload = {
            "exit_code": 0,
            # missing discovered_packages
            "available_upgrades": [],
            "raw_stderr": "",
        }
        with self.assertRaises(jsonschema.ValidationError):
            validate_scan_payload(invalid_payload)

    def test_validate_invalid_package_missing_installed_version(self):
        invalid_payload = {
            "exit_code": 0,
            "discovered_packages": [
                {
                    "name": "Incomplete App",
                    # missing installed_version
                    "is_managed": False,
                }
            ],
            "available_upgrades": [],
            "raw_stderr": "",
        }
        with self.assertRaises(jsonschema.ValidationError):
            validate_scan_payload(invalid_payload)


class TestFullScanPipelineSnapshot(unittest.TestCase):
    """Snapshot test executing full pipeline with real WinGet fixture and registry entries."""

    @patch("agent.scanner.scan.list_installed")
    @patch("agent.scanner.scan.get_winget_version")
    def test_full_scan_pipeline_snapshot(self, mock_ver, mock_list):
        # 1. Provide version
        mock_ver.return_value = "v1.29.380"

        # 2. Parse real fixture (193 apps)
        with open(REAL_LIST_FIXTURE_PATH, "r", encoding="utf-8") as f:
            raw_fixture = f.read()
        mock_list.return_value = parse_winget_list_output(raw_fixture)

        # 3. Provide registry data (contains Git and 7-Zip overlapping, plus 1 registry-only app)
        registry_data = [
            {
                "DisplayName": "Git for Windows",
                "DisplayVersion": "2.44.0",
                "Publisher": "The Git Development Community",
            },
            {
                "DisplayName": "7-Zip 24.09 (x64)",
                "DisplayVersion": "24.09",
                "Publisher": "Igor Pavlov",
            },
            {
                "DisplayName": "Custom Company Intranet Helper",
                "DisplayVersion": "1.0.4",
                "Publisher": "Acme Corp",
            },
        ]
        reg_backend = FakeRegistryBackend(entries=registry_data)

        # 4. Run full scan inventory pipeline
        scan_res = scan_inventory(registry_backend=reg_backend)

        # Verify scan metadata
        self.assertTrue(scan_res.winget_available)
        self.assertEqual(len(scan_res.errors), 0)

        # 193 raw WinGet rows deduplicate to 178 unique apps + 1 registry-only app = 179 total
        self.assertEqual(len(scan_res.apps), 179)

        # 5. Convert to API payload and validate against JSON schema
        payload = convert_scan_result_to_api_payload(scan_res)
        self.assertEqual(payload["exit_code"], 0)
        self.assertEqual(len(payload["discovered_packages"]), 179)
        self.assertEqual(payload["raw_stderr"], "")

        # Schema must be strictly valid
        validate_scan_payload(payload)

        # Find specific known apps and verify snapshot properties
        pkg_map = {p["name"]: p for p in payload["discovered_packages"]}

        # 7-Zip (merged with WinGet ID and Registry publisher)
        seven_zip = pkg_map.get("7-Zip 24.09 (x64)")
        self.assertIsNotNone(seven_zip)
        self.assertEqual(seven_zip["package_id"], "7zip.7zip")
        self.assertEqual(seven_zip["installed_version"], "24.09")
        self.assertEqual(seven_zip["publisher"], "Igor Pavlov")
        self.assertTrue(seven_zip["is_managed"])
        self.assertEqual(seven_zip["source"], "both")

        # Custom registry-only app
        acme = pkg_map.get("Custom Company Intranet Helper")
        self.assertIsNotNone(acme)
        self.assertIsNone(acme["package_id"])
        self.assertEqual(acme["installed_version"], "1.0.4")
        self.assertEqual(acme["publisher"], "Acme Corp")
        self.assertFalse(acme["is_managed"])

        # Unmanaged Photoshop with ARP package ID from WinGet
        photoshop = pkg_map.get("Adobe Photoshop 2021")
        self.assertIsNotNone(photoshop)
        self.assertIn("PHSP_22_0", photoshop["package_id"])
        self.assertFalse(photoshop["is_managed"])

        # Verify JSON serializability
        serialized = json.dumps(payload, indent=2)
        self.assertIn('"package_id": "7zip.7zip"', serialized)
        self.assertIn('"is_managed": true', serialized)
        self.assertIn('"is_managed": false', serialized)


if __name__ == "__main__":
    unittest.main()
