"""Secure token storage using Windows Credential Manager via keyring."""

import logging
from typing import Optional

try:
    import keyring
    from keyring.errors import KeyringError, PasswordDeleteError
except ImportError:  # pragma: no cover
    keyring = None  # type: ignore
    KeyringError = Exception  # type: ignore
    PasswordDeleteError = Exception  # type: ignore

logger = logging.getLogger(__name__)

KEYRING_SERVICE_NAME = "UpdatePilotAgent"
KEYRING_USERNAME = "agent_token"


def save_agent_token(token: str, service: str = KEYRING_SERVICE_NAME, username: str = KEYRING_USERNAME) -> None:
    """Save the agent token securely in Windows Credential Manager."""
    if not keyring:
        raise RuntimeError("keyring package is required for secure token storage.")
    keyring.set_password(service, username, token)


def get_agent_token(service: str = KEYRING_SERVICE_NAME, username: str = KEYRING_USERNAME) -> Optional[str]:
    """Retrieve the stored agent token from Windows Credential Manager."""
    if not keyring:
        raise RuntimeError("keyring package is required for secure token storage.")
    try:
        return keyring.get_password(service, username)
    except Exception as e:
        logger.debug("Failed to retrieve agent token from keyring: %s", type(e).__name__)
        return None


def delete_agent_token(service: str = KEYRING_SERVICE_NAME, username: str = KEYRING_USERNAME) -> bool:
    """Delete the stored agent token from Windows Credential Manager.

    Returns True if deleted or did not exist, False on unexpected failure.
    """
    if not keyring:
        raise RuntimeError("keyring package is required for secure token storage.")
    try:
        keyring.delete_password(service, username)
        return True
    except (PasswordDeleteError, KeyringError):
        # Already deleted or not found
        return True
    except Exception as e:
        logger.debug("Unexpected error deleting agent token: %s", type(e).__name__)
        return False
