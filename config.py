"""
Configuration loader for Sprout Social MCP server.

Loads environment variables from .env file located next to this script.
"""

from pathlib import Path

from dotenv import load_dotenv
import os

# Load .env relative to this file, not the working directory
load_dotenv(Path(__file__).parent / ".env")

SPROUT_API_TOKEN = os.environ.get("SPROUT_API_TOKEN", "")
SPROUT_CUSTOMER_ID = os.environ.get("SPROUT_CUSTOMER_ID", "")
SPROUT_DEFAULT_TIMEZONE = os.environ.get(
    "SPROUT_DEFAULT_TIMEZONE", "America/Los_Angeles"
)
BASE_URL = "https://api.sproutsocial.com"
