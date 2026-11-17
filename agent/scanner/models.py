"""Data models for installed application inventory scanning."""

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Literal, Optional

SourceType = Literal["winget", "registry", "both"]
PublisherSource = Literal["registry", "winget_show", "derived"]


@dataclass
class InstalledApp:
    """Represents a discovered installed application on the host."""

    name: str
    version: str
    publisher: Optional[str] = None
    package_id: Optional[str] = None
    source: SourceType = "winget"
    raw_name: Optional[str] = None
    publisher_source: Optional[PublisherSource] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert InstalledApp to serializable dictionary."""
        return {
            "name": self.name,
            "version": self.version,
            "publisher": self.publisher,
            "package_id": self.package_id,
            "source": self.source,
            "raw_name": self.raw_name,
            "publisher_source": self.publisher_source,
        }


@dataclass
class ScanResult:
    """Represents aggregate outcome of an inventory scan."""

    apps: List[InstalledApp] = field(default_factory=list)
    started_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    finished_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    warnings: List[str] = field(default_factory=list)
    errors: List[str] = field(default_factory=list)
    winget_available: bool = False

    def to_dict(self) -> Dict[str, Any]:
        """Convert ScanResult to serializable dictionary."""
        return {
            "apps": [app.to_dict() for app in self.apps],
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "warnings": list(self.warnings),
            "errors": list(self.errors),
            "winget_available": self.winget_available,
        }


@dataclass
class UpdateCandidate:
    """Represents an available package update discovered by `winget upgrade`."""

    name: str
    package_id: str
    installed_version: str
    available_version: str
    source: str = "winget"
    pinned: bool = False
    truncated: bool = False

    def to_dict(self) -> Dict[str, Any]:
        """Convert UpdateCandidate to serializable dictionary."""
        return {
            "name": self.name,
            "package_id": self.package_id,
            "installed_version": self.installed_version,
            "available_version": self.available_version,
            "source": self.source,
            "pinned": self.pinned,
            "truncated": self.truncated,
        }


@dataclass
class CheckUpdatesResult:
    """Represents the outcome of a read-only `check_updates` operation."""

    updates: List[UpdateCandidate] = field(default_factory=list)
    winget_available: bool = False
    checked_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    warnings: List[str] = field(default_factory=list)
    errors: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        """Convert CheckUpdatesResult to serializable dictionary."""
        return {
            "updates": [u.to_dict() for u in self.updates],
            "winget_available": self.winget_available,
            "checked_at": self.checked_at,
            "warnings": list(self.warnings),
            "errors": list(self.errors),
        }


@dataclass
class PackageMetadata:
    """Represents release information and source metadata for a package."""

    package_id: str
    version: Optional[str] = None
    publisher: Optional[str] = None
    homepage_url: Optional[str] = None
    publisher_url: Optional[str] = None
    release_notes_url: Optional[str] = None
    release_notes_text: Optional[str] = None
    installer_type: Optional[str] = None
    fetch_status: str = "success"  # "success" | "not_found" | "timeout" | "error"
    error: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert PackageMetadata to serializable dictionary."""
        return {
            "package_id": self.package_id,
            "version": self.version,
            "publisher": self.publisher,
            "homepage_url": self.homepage_url,
            "publisher_url": self.publisher_url,
            "release_notes_url": self.release_notes_url,
            "release_notes_text": self.release_notes_text,
            "installer_type": self.installer_type,
            "fetch_status": self.fetch_status,
            "error": self.error,
        }


@dataclass
class GetPackageMetadataResult:
    """Represents the aggregate outcome of a `get_package_metadata` operation."""

    packages: List[PackageMetadata] = field(default_factory=list)
    fetched_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    warnings: List[str] = field(default_factory=list)
    errors: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        """Convert GetPackageMetadataResult to serializable dictionary."""
        return {
            "packages": [p.to_dict() for p in self.packages],
            "fetched_at": self.fetched_at,
            "warnings": list(self.warnings),
            "errors": list(self.errors),
        }

