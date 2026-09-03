"""
Sprout Social MCP Server.

Exposes Sprout Social API operations as MCP tools for use in Claude Code.
Transport: stdio
"""

from typing import Optional

from mcp.server.fastmcp import FastMCP

from sprout_client import SproutClient

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
            "PHOTO" or "VIDEO". If omitted, defaults to "PHOTO" for all items.
            Use the _detected_media_type from upload_media's response to set this.
        tag_ids: List of tag IDs from list_tags for organizing/categorizing the post.

    Note: Posts are created as drafts. Whether scheduled drafts auto-publish depends
    on your Sprout account's approval workflow settings.
    """
    if not profile_ids:
        return {"error": "profile_ids must not be empty", "status_code": 400}
    if not text or not text.strip():
        return {"error": "text must not be blank", "status_code": 400}
    if media_types and any(mt not in ("PHOTO", "VIDEO") for mt in media_types):
        return {
            "error": "media_types values must be 'PHOTO' or 'VIDEO'",
            "status_code": 400,
        }

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
    """Upload an image or video to Sprout Social via a public URL or Google Drive link.

    Supports:
    - Direct public URLs (passed through to Sprout's API)
    - Google Drive URLs (file is downloaded server-side and uploaded via multipart).
      Supported formats: drive.google.com/file/d/{ID}/..., drive.google.com/open?id={ID},
      drive.usercontent.google.com/download?id={ID}, drive.google.com/uc?export=download&id={ID}

    Args:
        url: URL of the media file (public URL or Google Drive share link). Must be < 50MB.
            Google Drive files must have "Anyone with the link" sharing enabled.

    Returns a media_id and detected media_type (PHOTO or VIDEO) that can be used
    in create_post. The media_id expires 24 hours after upload.
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


if __name__ == "__main__":
    mcp.run(transport="stdio")
