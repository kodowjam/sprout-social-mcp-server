"""
Listening helpers: filter building, validation and response shaping for
the Topic Messages and Topic Metrics endpoints.
"""

import json
import math
import re
from dataclasses import dataclass, field
from typing import Any, Optional

LISTENING_NETWORKS = [
    "LINKEDIN",
    "REDDIT",
    "YOUTUBE",
    "INSTAGRAM",
    "TIKTOK",
    "WWW",
    "BLUESKY",
    "FACEBOOK",
    "TUMBLR",
]

# X data is not returned by the Listening API.
X_NETWORKS = {"TWITTER", "X"}

X_UNAVAILABLE_NOTE = (
    "X (Twitter) listening data isn't available via the Sprout API, "
    "so X was left out of this request."
)

SENTIMENTS = ["positive", "negative", "neutral", "unclassified"]

ALLOWED_DIMENSIONS = [
    "created_time.by(day)",
    "created_time.by(month)",
    "visual_media.media_type",
    "distribution_type",
    "network",
    "sentiment",
    "language",
    "explicit_label",
    "location.city",
    "location.province",
    "location.country",
]

DEFAULT_MESSAGE_FIELDS = [
    "guid",
    "created_time",
    "network",
    "text",
    "perma_link",
    "from.name",
    "from.screen_name",
    "content_category",
    "language",
    "sentiment",
]

DEFAULT_MESSAGE_METRICS = [
    "engagements",
    "likes",
    "replies",
    "shares_count",
    "impressions",
    "from.followers_count",
]

MESSAGES_PAGE_SIZE = 100  # API max
DEFAULT_MAX_RESULTS = 100
MAX_RESULTS_CAP = 500

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


@dataclass
class BuiltFilters:
    filters: list[str]
    notes: list[str] = field(default_factory=list)
    # True when the caller only asked for networks the API can't serve (X).
    no_networks_left: bool = False


def validate_listening_params(
    start_date: str,
    end_date: str,
    sentiment: Optional[list[str]] = None,
) -> Optional[str]:
    """Validate the structured params shared by both listening tools.
    Returns an error message, or None if valid."""
    if not DATE_RE.match(start_date or ""):
        return "start_date must be in YYYY-MM-DD format"
    if not DATE_RE.match(end_date or ""):
        return "end_date must be in YYYY-MM-DD format"
    if start_date > end_date:
        return "start_date must be on or before end_date"
    if sentiment:
        bad = [s for s in sentiment if s.lower() not in SENTIMENTS]
        if bad:
            return (
                f"sentiment values must be one of {', '.join(SENTIMENTS)} "
                f"(got {', '.join(bad)})"
            )
    return None


def build_listening_filters(
    start_date: str,
    end_date: str,
    networks: Optional[list[str]] = None,
    text_match: Optional[str] = None,
    sentiment: Optional[list[str]] = None,
    exclude_profile_ids: Optional[list[Any]] = None,
    filters: Optional[list[str]] = None,
) -> BuiltFilters:
    """Build the Listening filters array from structured params.

    Always includes a created_time range. The API requires a network or
    profile filter, so when networks is omitted all listening networks are used.
    """
    notes: list[str] = []
    built = [f"created_time.in({start_date}..{end_date}T23:59:59)"]

    selected = LISTENING_NETWORKS
    if networks:
        requested = [n.strip().upper() for n in networks]
        selected = [n for n in requested if n not in X_NETWORKS]
        if len(selected) < len(requested):
            notes.append(X_UNAVAILABLE_NOTE)
        if not selected:
            return BuiltFilters(built, notes, no_networks_left=True)
    built.append(f"network.eq({','.join(selected)})")

    if text_match and text_match.strip():
        built.append(f"text.match({text_match.strip()})")
    if sentiment:
        built.append(f"sentiment.eq({','.join(s.lower() for s in sentiment)})")
    if exclude_profile_ids:
        built.append(f"profile.neq({','.join(str(p) for p in exclude_profile_ids)})")
    if filters:
        built.extend(filters)

    return BuiltFilters(built, notes)


def invalid_dimensions(dimensions: list[str]) -> list[str]:
    """Return the dimensions that aren't in ALLOWED_DIMENSIONS."""
    return [d for d in dimensions if d not in ALLOWED_DIMENSIONS]


def clamp_max_results(max_results: Optional[int]) -> int:
    """Clamp max_results to 1..MAX_RESULTS_CAP, defaulting to DEFAULT_MAX_RESULTS."""
    if max_results is None or (isinstance(max_results, float) and math.isnan(max_results)):
        return DEFAULT_MAX_RESULTS
    return max(1, min(MAX_RESULTS_CAP, int(max_results)))


def shape_message(message: dict, keep_visual_media: bool) -> dict:
    """Compact a listening message for LLM context: flatten
    listening_metadata.sentiment to a top-level sentiment and drop
    visual_media unless the caller asked for it."""
    shaped = dict(message)
    meta = shaped.get("listening_metadata")
    if isinstance(meta, dict):
        if "sentiment" in meta and "sentiment" not in shaped:
            shaped["sentiment"] = meta["sentiment"]
        rest = {k: v for k, v in meta.items() if k != "sentiment"}
        if rest:
            shaped["listening_metadata"] = rest
        else:
            del shaped["listening_metadata"]
    if not keep_visual_media:
        shaped.pop("visual_media", None)
    return shaped


def format_listening_error(result: dict) -> dict:
    """Turn a Sprout error result ({error, status_code}) into a clearer error
    for the listening tools. Passes Sprout's message through; 400s become
    "invalid request", naming the field when Sprout provides one."""
    status = result.get("status_code")
    if status == 429:
        return {
            "error": (
                "Sprout rate limit hit (60 requests/minute) and retries were "
                "exhausted. Wait a minute and try again, or request fewer results."
            ),
            "status_code": 429,
        }

    message: Any = result.get("error", "Unknown error")
    field_name = None
    try:
        parsed = json.loads(message)
        if isinstance(parsed, dict):
            message = parsed.get("error", parsed.get("message", message))
            field_name = parsed.get("field", parsed.get("parameter"))
    except (TypeError, ValueError):
        pass  # Not JSON; use the raw text.
    if not isinstance(message, str):
        message = json.dumps(message)

    if status == 400:
        out = {
            "error": (
                f"invalid request{f' (field: {field_name})' if field_name else ''}: "
                f"{message}"
            ),
            "status_code": 400,
        }
        if field_name:
            out["field"] = field_name
        return out
    if status in (401, 403):
        return {
            "error": (
                f"Sprout denied access to the Listening API: {message}. "
                "Listening API access must be enabled for this token."
            ),
            "status_code": status,
        }
    return {**result, "error": message}
