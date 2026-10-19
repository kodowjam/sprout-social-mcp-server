"""
Handlers for the listening tools and the create_post document guard.
"""

from typing import Any, Optional, Union

from sprout_client import SproutClient
from listening import (
    ALLOWED_DIMENSIONS,
    DEFAULT_MESSAGE_FIELDS,
    DEFAULT_MESSAGE_METRICS,
    BuiltFilters,
    build_listening_filters,
    clamp_max_results,
    format_listening_error,
    invalid_dimensions,
    shape_message,
    validate_listening_params,
)

# Sprout network_type values that accept DOCUMENT (PDF) media.
DOCUMENT_NETWORK_TYPES = {"linkedin_company", "linkedin"}


def _bad_request(error: str) -> dict:
    return {"error": f"invalid request: {error}", "status_code": 400}


async def _prepare_filters(
    client: SproutClient,
    topic_id: str,
    start_date: str,
    end_date: str,
    networks: Optional[list[str]],
    text_match: Optional[str],
    sentiment: Optional[list[str]],
    public_only: bool,
    filters: Optional[list[str]],
) -> Union[dict, BuiltFilters]:
    """Validate common args and build the filters array, looking up owned
    profile IDs when public_only is set. Returns an error dict or BuiltFilters."""
    if not topic_id:
        return _bad_request("topic_id is required")
    invalid = validate_listening_params(start_date, end_date, sentiment)
    if invalid:
        return _bad_request(invalid)

    exclude_profile_ids = None
    if public_only:
        profiles = await client.list_profiles()
        if "error" in profiles:
            return format_listening_error(profiles)
        exclude_profile_ids = [
            p.get("customer_profile_id") for p in profiles.get("data", [])
        ]

    return build_listening_filters(
        start_date,
        end_date,
        networks=networks,
        text_match=text_match,
        sentiment=sentiment,
        exclude_profile_ids=exclude_profile_ids,
        filters=filters,
    )


async def list_listening_topics(client: SproutClient) -> dict:
    result = await client.list_listening_topics()
    if "error" in result:
        return format_listening_error(result)
    topics = [
        {
            "id": t.get("id"),
            "name": t.get("name"),
            "topic_type": t.get("topic_type"),
            "description": t.get("description"),
            "group_id": t.get("group_id"),
            "theme_groups": [
                {
                    "name": g.get("name"),
                    "themes": [
                        {"id": th.get("id"), "name": th.get("name")}
                        for th in g.get("themes", [])
                    ],
                }
                for g in t.get("theme_groups", [])
            ],
            "availability_time": t.get("availability_time"),
        }
        for t in result.get("data", [])
    ]
    if not topics:
        return {
            "data": [],
            "note": (
                "No Listening Topics were returned. Either the account has no "
                "Topics, or this API token doesn't have Listening access."
            ),
        }
    return {"data": topics}


async def get_topic_messages(
    client: SproutClient,
    default_timezone: str,
    topic_id: str,
    start_date: str,
    end_date: str,
    networks: Optional[list[str]] = None,
    text_match: Optional[str] = None,
    sentiment: Optional[list[str]] = None,
    public_only: bool = False,
    fields: Optional[list[str]] = None,
    metrics: Optional[list[str]] = None,
    sort: Optional[list[str]] = None,
    max_results: Optional[int] = None,
    filters: Optional[list[str]] = None,
    timezone: Optional[str] = None,
) -> dict:
    prepared = await _prepare_filters(
        client, topic_id, start_date, end_date, networks, text_match,
        sentiment, public_only, filters,
    )
    if isinstance(prepared, dict):
        return prepared
    if prepared.no_networks_left:
        return {"data": [], "notes": prepared.notes}

    fields = fields or DEFAULT_MESSAGE_FIELDS
    keep_visual_media = "visual_media" in fields

    result = await client.get_topic_messages(
        topic_id,
        {
            "filters": prepared.filters,
            "fields": fields,
            "metrics": metrics or DEFAULT_MESSAGE_METRICS,
            "sort": sort or ["created_time:desc"],
            "timezone": timezone or default_timezone,
        },
        clamp_max_results(max_results),
    )
    if "error" in result:
        return format_listening_error(result)

    out: dict[str, Any] = {
        "data": [shape_message(m, keep_visual_media) for m in result.get("data", [])],
        "paging": result.get("paging"),
    }
    if prepared.notes:
        out["notes"] = prepared.notes
    return out


async def get_topic_metrics(
    client: SproutClient,
    default_timezone: str,
    topic_id: str,
    start_date: str,
    end_date: str,
    metrics: list[str],
    dimensions: Optional[list[str]] = None,
    networks: Optional[list[str]] = None,
    text_match: Optional[str] = None,
    sentiment: Optional[list[str]] = None,
    public_only: bool = False,
    filters: Optional[list[str]] = None,
    timezone: Optional[str] = None,
) -> dict:
    if not metrics:
        return _bad_request("metrics must not be empty")
    if dimensions:
        invalid = invalid_dimensions(dimensions)
        if invalid:
            return _bad_request(
                f"unsupported dimensions: {', '.join(invalid)}. "
                f"Allowed: {', '.join(ALLOWED_DIMENSIONS)}"
            )

    prepared = await _prepare_filters(
        client, topic_id, start_date, end_date, networks, text_match,
        sentiment, public_only, filters,
    )
    if isinstance(prepared, dict):
        return prepared
    if prepared.no_networks_left:
        return {"data": [], "notes": prepared.notes}

    body: dict[str, Any] = {
        "filters": prepared.filters,
        "metrics": metrics,
        "timezone": timezone or default_timezone,
    }
    if dimensions:
        body["dimensions"] = dimensions

    result = await client.get_topic_metrics(topic_id, body)
    if "error" in result:
        return format_listening_error(result)
    if prepared.notes:
        result = {**result, "notes": prepared.notes}
    return result


async def check_document_profiles(
    client: SproutClient,
    profile_ids: list[Any],
    media_types: Optional[list[str]],
) -> Optional[dict]:
    """Sprout silently drops profiles that can't take an attached media type.
    When any media is DOCUMENT, check every target profile accepts documents.
    Returns an error dict to send back, or None if the post can go ahead."""
    if not media_types or "DOCUMENT" not in media_types:
        return None

    profiles = await client.list_profiles()
    if "error" in profiles:
        return profiles
    by_id = {str(p.get("customer_profile_id")): p for p in profiles.get("data", [])}

    incompatible = []
    for pid in profile_ids:
        profile = by_id.get(str(pid))
        if not profile:
            incompatible.append({"profile_id": str(pid), "reason": "profile not found"})
        elif profile.get("network_type") not in DOCUMENT_NETWORK_TYPES:
            incompatible.append(
                {
                    "profile_id": str(pid),
                    "name": profile.get("name"),
                    "network_type": profile.get("network_type"),
                }
            )

    if not incompatible:
        return None
    return {
        "error": (
            "DOCUMENT (PDF) media can only be posted to LinkedIn company pages "
            "and personal profiles. Sprout would silently drop the other "
            "profiles, so this post was not created. Remove these profiles or "
            "the document and try again."
        ),
        "incompatible_profiles": incompatible,
        "status_code": 400,
    }
