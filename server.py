"""
Sprout Social MCP Server.

Exposes Sprout Social API operations as MCP tools for use in Claude Code.
Transport: stdio
"""

from typing import Literal, Optional

from mcp.server.fastmcp import FastMCP

import handlers
from sprout_client import SproutClient
from config import SPROUT_DEFAULT_TIMEZONE

mcp = FastMCP("Sprout Social")
client = SproutClient()


# --- Tier 1: Core Workflow ---


@mcp.tool()
async def get_customer_id() -> dict:
    """Get your Sprout Social customer ID. Use this during initial setup to find
    the customer ID needed for all other API calls."""
    return await client.get_customer_id()


@mcp.tool()
async def list_profiles() -> dict:
    """List all connected social media profiles (LinkedIn, X/Twitter, Instagram,
    Facebook, etc.) with their IDs, network types, names, and group IDs.
    Use this to get profile_ids and group_id for creating posts."""
    return await client.list_profiles()


@mcp.tool()
async def create_post(
    profile_ids: list[str],
    text: str,
    group_id: Optional[int] = None,
    scheduled_at: Optional[str] = None,
    media_ids: Optional[list[str]] = None,
    media_types: Optional[list[str]] = None,
    tag_ids: Optional[list[int]] = None,
) -> dict:
    """Create a draft social media post in Sprout Social, optionally scheduled.

    Args:
        profile_ids: List of social profile IDs to post to (from list_profiles).
        text: The post text content. Network-specific limits are validated by Sprout.
        group_id: Group ID (from list_profiles). May be required by your account.
        scheduled_at: ISO 8601 datetime for scheduling (e.g. "2026-03-20T14:00:00Z").
            If omitted, creates an unscheduled draft.
        media_ids: List of media IDs from upload_media (must be used within 24hr of upload).
        media_types: List of media types corresponding to media_ids. Each must be
            "PHOTO", "VIDEO" or "DOCUMENT". If omitted, defaults to "PHOTO" for all items.
            Use the _detected_media_type from upload_media's response to set this.
            DOCUMENT (PDF) posts can only target LinkedIn company pages and personal
            profiles; the call is rejected if any other profile is included.
        tag_ids: List of tag IDs from list_tags for organizing/categorizing the post.

    Note: Posts are created as drafts. Whether scheduled drafts auto-publish depends
    on your Sprout account's approval workflow settings.
    """
    if not profile_ids:
        return {"error": "profile_ids must not be empty", "status_code": 400}
    if not text or not text.strip():
        return {"error": "text must not be blank", "status_code": 400}
    if media_types and any(
        mt not in ("PHOTO", "VIDEO", "DOCUMENT") for mt in media_types
    ):
        return {
            "error": "media_types values must be 'PHOTO', 'VIDEO' or 'DOCUMENT'",
            "status_code": 400,
        }

    document_error = await handlers.check_document_profiles(
        client, profile_ids, media_types
    )
    if document_error:
        return document_error

    return await client.create_post(
        profile_ids=profile_ids,
        text=text,
        group_id=group_id,
        scheduled_at=scheduled_at,
        media_ids=media_ids,
        media_types=media_types,
        tag_ids=tag_ids,
    )


@mcp.tool()
async def get_post(post_id: str) -> dict:
    """Get details and status of a specific post by its ID.

    Args:
        post_id: The Sprout Social post ID.
    """
    return await client.get_post(post_id)


# --- Tier 2: Media, Metadata & Post Management ---


@mcp.tool()
async def upload_media(url: str) -> dict:
    """Upload an image, video or PDF document to Sprout Social via a public URL or Google Drive link.

    Supports:
    - Direct public URLs (passed through to Sprout's API)
    - Google Drive URLs (file is downloaded server-side and uploaded via multipart).
      Supported formats: drive.google.com/file/d/{ID}/..., drive.google.com/open?id={ID},
      drive.usercontent.google.com/download?id={ID}, drive.google.com/uc?export=download&id={ID}

    Args:
        url: URL of the media file (public URL or Google Drive share link). Must be < 50MB.
            Google Drive files must have "Anyone with the link" sharing enabled.

    Returns a media_id and _detected_media_type (PHOTO, VIDEO or DOCUMENT for PDFs)
    that can be used in create_post. PDFs become LinkedIn document posts.
    The media_id expires 24 hours after upload.
    """
    return await client.upload_media(url)


@mcp.tool()
async def list_tags() -> dict:
    """List all available tags/labels in Sprout Social for organizing posts.
    Returns tag IDs that can be passed to create_post's tag_ids parameter."""
    return await client.list_tags()


@mcp.tool()
async def list_users() -> dict:
    """List all users on the Sprout Social account."""
    return await client.list_users()


# --- Tier 3: Analytics ---


@mcp.tool()
async def get_profile_analytics(
    profile_ids: list[str],
    start_date: str,
    end_date: str,
    metrics: list[str],
) -> dict:
    """Get aggregated analytics for social profiles over a date range.

    Args:
        profile_ids: List of profile IDs to get analytics for.
        start_date: Start date in YYYY-MM-DD format.
        end_date: End date in YYYY-MM-DD format.
        metrics: List of metric names (e.g. ["impressions", "engagements", "followers"]).
    """
    if not profile_ids:
        return {"error": "profile_ids must not be empty", "status_code": 400}

    return await client.get_profile_analytics(
        profile_ids=profile_ids,
        start_date=start_date,
        end_date=end_date,
        metrics=metrics,
    )


@mcp.tool()
async def get_post_analytics(
    profile_ids: list[str],
    start_date: str,
    end_date: str,
    metrics: Optional[list[str]] = None,
) -> dict:
    """Get per-post performance metrics over a date range.

    Returns individual post data (text, link, author) with lifetime metrics.
    Automatically fetches all pages (50 posts/page) and returns combined results.

    Args:
        profile_ids: List of profile IDs to get post analytics for.
        start_date: Start date in YYYY-MM-DD format.
        end_date: End date in YYYY-MM-DD format.
        metrics: List of lifetime-prefixed metric names. Defaults to:
            lifetime.impressions, lifetime.engagements, lifetime.post_link_clicks,
            lifetime.post_shares_count, lifetime.likes, lifetime.comments_count.
            Not all metrics are available on all networks (e.g. YouTube may lack impressions).
    """
    if not profile_ids:
        return {"error": "profile_ids must not be empty", "status_code": 400}

    return await client.get_post_analytics(
        profile_ids=profile_ids,
        start_date=start_date,
        end_date=end_date,
        metrics=metrics,
    )


# --- Tier 4: Listening ---


@mcp.tool()
async def list_listening_topics() -> dict:
    """List the Sprout Social Listening Topics on the account, with their themes
    and how far back data is available.

    Use the topic id from this tool as topic_id in get_topic_messages and
    get_topic_metrics.

    Requires Listening API access. X (Twitter) data is not available from the
    Listening API, and Reddit is available in metrics only."""
    return await handlers.list_listening_topics(client)


@mcp.tool()
async def get_topic_messages(
    topic_id: str,
    start_date: str,
    end_date: str,
    networks: Optional[list[str]] = None,
    text_match: Optional[str] = None,
    sentiment: Optional[
        list[Literal["positive", "negative", "neutral", "unclassified"]]
    ] = None,
    public_only: bool = False,
    fields: Optional[list[str]] = None,
    metrics: Optional[list[str]] = None,
    sort: Optional[list[str]] = None,
    max_results: Optional[int] = None,
    filters: Optional[list[str]] = None,
    timezone: Optional[str] = None,
) -> dict:
    """Get messages (posts, comments, articles) from a Sprout Listening Topic over
    a date range, newest first, with sentiment and engagement.

    Automatically fetches pages of 100 until max_results is reached. Responses are
    compact: sentiment is a top-level field and media URLs are dropped unless you
    request the visual_media field.

    Args:
        topic_id: Topic ID from list_listening_topics.
        start_date: Start date in YYYY-MM-DD format.
        end_date: End date in YYYY-MM-DD format (inclusive).
        networks: Networks to include, e.g. ["LINKEDIN", "REDDIT", "YOUTUBE",
            "INSTAGRAM", "TIKTOK", "WWW", "BLUESKY", "FACEBOOK", "TUMBLR"].
            Defaults to all of these. X/TWITTER is not available via the API and
            is dropped with a note.
        text_match: Text search. All terms are required; use OR for any, and
            quotes for phrases, e.g. '"Fireworks AI" OR fireworks.ai'.
        sentiment: Filter by sentiment: positive, negative, neutral, unclassified.
        public_only: If true, exclude posts from the account's own connected
            profiles so only earned/public conversation is returned. Default false.
        fields: Message fields to return. Defaults to guid, created_time, network,
            text, perma_link, from.name, from.screen_name, content_category,
            language, sentiment.
        metrics: Per-message metrics. Defaults to engagements, likes, replies,
            shares_count, impressions, from.followers_count.
        sort: Sort order. Defaults to ["created_time:desc"].
        max_results: Maximum messages to return. Default 100, maximum 500.
        filters: Extra raw Sprout filter strings appended as-is,
            e.g. ["likes.gte(10)"].
        timezone: IANA timezone for date filters. Defaults to
            SPROUT_DEFAULT_TIMEZONE (America/Los_Angeles).
    """
    return await handlers.get_topic_messages(
        client,
        SPROUT_DEFAULT_TIMEZONE,
        topic_id=topic_id,
        start_date=start_date,
        end_date=end_date,
        networks=networks,
        text_match=text_match,
        sentiment=sentiment,
        public_only=public_only,
        fields=fields,
        metrics=metrics,
        sort=sort,
        max_results=max_results,
        filters=filters,
        timezone=timezone,
    )


@mcp.tool()
async def get_topic_metrics(
    topic_id: str,
    start_date: str,
    end_date: str,
    metrics: list[str],
    dimensions: Optional[list[str]] = None,
    networks: Optional[list[str]] = None,
    text_match: Optional[str] = None,
    sentiment: Optional[
        list[Literal["positive", "negative", "neutral", "unclassified"]]
    ] = None,
    public_only: bool = False,
    filters: Optional[list[str]] = None,
    timezone: Optional[str] = None,
) -> dict:
    """Get aggregate metrics for a Sprout Listening Topic over a date range,
    optionally broken down by dimensions. Returns everything in one response.

    Examples:
        Volume by day: metrics=["messages_count"], dimensions=["created_time.by(day)"]
        Sentiment split: metrics=["messages_count"], dimensions=["sentiment"]
        Volume by network: metrics=["messages_count", "engagements"],
            dimensions=["network"]

    Args:
        topic_id: Topic ID from list_listening_topics.
        start_date: Start date in YYYY-MM-DD format.
        end_date: End date in YYYY-MM-DD format (inclusive).
        metrics: Metrics to aggregate: messages_count, engagements, likes, replies,
            shares_count, quote_count, reshare_count, repost_count, impressions,
            authors_count, from.followers_count, positive_sentiments_count,
            neutral_sentiments_count, negative_sentiments_count.
        dimensions: Optional breakdowns: created_time.by(day), created_time.by(month),
            visual_media.media_type, distribution_type, network, sentiment, language,
            explicit_label, location.city, location.province, location.country.
        networks: Networks to include. Defaults to all listening networks.
            X/TWITTER is not available via the API and is dropped with a note.
        text_match: Text search; supports OR and quoted phrases.
        sentiment: Filter by sentiment: positive, negative, neutral, unclassified.
        public_only: If true, exclude the account's own connected profiles.
            Default false.
        filters: Extra raw Sprout filter strings appended as-is.
        timezone: IANA timezone for date filters and day/month buckets. Defaults to
            SPROUT_DEFAULT_TIMEZONE (America/Los_Angeles).
    """
    return await handlers.get_topic_metrics(
        client,
        SPROUT_DEFAULT_TIMEZONE,
        topic_id=topic_id,
        start_date=start_date,
        end_date=end_date,
        metrics=metrics,
        dimensions=dimensions,
        networks=networks,
        text_match=text_match,
        sentiment=sentiment,
        public_only=public_only,
        filters=filters,
        timezone=timezone,
    )


if __name__ == "__main__":
    mcp.run(transport="stdio")
