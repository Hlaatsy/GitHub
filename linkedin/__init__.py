"""Post and schedule LinkedIn content via LinkedIn's official REST API."""

from .client import LinkedInClient, LinkedInError

__all__ = ["LinkedInClient", "LinkedInError"]
