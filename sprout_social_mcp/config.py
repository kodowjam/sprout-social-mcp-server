"""
Configuration loader for Sprout Social MCP server package.

For the PyPI/uvx distribution, credentials are provided via environment
variables set in the MCP configuration (no .env file needed).
"""

import os

SPROUT_API_TOKEN = os.environ.get("SPROUT_API_TOKEN", "")
SPROUT_CUSTOMER_ID = os.environ.get("SPROUT_CUSTOMER_ID", "")
SPROUT_DEFAULT_TIMEZONE = os.environ.get(
    "SPROUT_DEFAULT_TIMEZONE", "America/Los_Angeles"
)
BASE_URL = "https://api.sproutsocial.com"
