"""
Sprout Social API client.

Async HTTP client with Bearer token auth, exponential backoff on 429/5xx,
and proactive rate limiting (60 req/min).
"""

import asyncio
import re
import time
from collections import deque
from typing import Any, Optional

import httpx

from config import BASE_URL, SPROUT_API_TOKEN, SPROUT_CUSTOMER_ID
from media_utils import (
    MAX_FILE_SIZE,
    extract_gdrive_file_id,
    detect_media_type,
)

MAX_RETRIES = 3
RATE_LIMIT_PER_MINUTE = 60


class SproutClient:
    def __init__(
        self,
        token: str = SPROUT_API_TOKEN,
        customer_id: str = SPROUT_CUSTOMER_ID,
        base_url: str = BASE_URL,
    ):
        self.token = token
        self.customer_id = customer_id
        self.base_url = base_url
        self._request_timestamps: deque[float] = deque()
        self._client: Optional[httpx.AsyncClient] = None

    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                headers={
                    "Authorization": f"Bearer {self.token}",
                    "Content-Type": "application/json",
                },
                timeout=30.0,
            )
        return self._client

    async def close(self):
        if self._client and not self._client.is_closed:
            await self._client.aclose()

    async def _throttle(self):
        """Proactively wait if we're approaching the 60 req/min limit."""
        now = time.monotonic()
        # Remove timestamps older than 60 seconds
        while self._request_timestamps and self._request_timestamps[0] < now - 60:
            self._request_timestamps.popleft()

        if len(self._request_timestamps) >= RATE_LIMIT_PER_MINUTE - 1:
            oldest = self._request_timestamps[0]
            wait = 60 - (now - oldest) + 0.1
            if wait > 0:
                await asyncio.sleep(wait)

        self._request_timestamps.append(time.monotonic())

    async def _request(
        self,
        method: str,
        path: str,
        json: Optional[dict] = None,
        params: Optional[dict] = None,
    ) -> dict[str, Any]:
        """
        Make an API request with retry + exponential backoff for 429/5xx.
        Returns parsed JSON on success, or an error dict on failure.
        """
        client = self._get_client()
        url = f"{self.base_url}{path}"

        last_status = 0
        last_body = ""

        for attempt in range(MAX_RETRIES):
            await self._throttle()

            response = await client.request(
                method, url, json=json, params=params
            )

            if response.status_code in (200, 201):
                return response.json()

            if response.status_code == 204:
                return {"success": True}

            last_status = response.status_code
            last_body = response.text

            if response.status_code == 429:
                retry_after = response.headers.get("Retry-After")
                wait = max(2**attempt, int(retry_after) if retry_after else 0)
                await asyncio.sleep(wait)
                continue

            if response.status_code >= 500:
                wait = 2**attempt
                await asyncio.sleep(wait)
                continue

            # 4xx (not 429) — don't retry
            return {
                "error": response.text,
                "status_code": response.status_code,
            }

        return {
            "error": f"Sprout API returned {last_status} after {MAX_RETRIES} retries",
            "status_code": last_status,
            "sprout_error": last_body,
            "attempts": MAX_RETRIES,
        }

    async def _download_gdrive_file(
        self, file_id: str
    ) -> tuple[bytes, str, Optional[str]]:
        """Download a file from Google Drive by file ID.

        Handles the large-file virus scan confirmation page.
        Returns (file_bytes, content_type, filename).
        """
        download_url = (
            f"https://drive.google.com/uc?export=download&id={file_id}"
        )

        async with httpx.AsyncClient(
            timeout=120.0, follow_redirects=True
        ) as dl_client:
            response = await dl_client.get(download_url)

            if response.status_code == 404:
                raise ValueError(
                    "Google Drive file not found. Check the file ID and "
                    "ensure the file exists."
                )
            if response.status_code in (401, 403):
                raise PermissionError(
                    "Google Drive file not accessible. Ensure sharing is set "
                    "to 'Anyone with the link'."
                )

            # Handle large-file confirmation page (virus scan warning)
            content_type = response.headers.get("content-type", "")
            if "text/html" in content_type:
                confirm_token = None
                for cookie_name, cookie_value in response.cookies.items():
                    if cookie_name.startswith("download_warning"):
                        confirm_token = cookie_value
                        break
                if not confirm_token:
                    match = re.search(r"confirm=([a-zA-Z0-9_-]+)", response.text)
                    if match:
                        confirm_token = match.group(1)
                if not confirm_token:
                    raise ValueError(
                        "Google Drive file not accessible. Ensure sharing is "
                        "set to 'Anyone with the link' and the file exists."
                    )
                confirm_url = (
                    f"https://drive.google.com/uc?export=download"
                    f"&confirm={confirm_token}&id={file_id}"
                )
                response = await dl_client.get(
                    confirm_url, cookies=response.cookies
                )

            # Check file size from Content-Length header
            content_length = response.headers.get("content-length")
            if content_length and int(content_length) > MAX_FILE_SIZE:
                raise ValueError(
                    f"File exceeds {MAX_FILE_SIZE // (1024 * 1024)}MB size "
                    f"limit ({int(content_length) // (1024 * 1024)}MB)."
                )

            file_data = response.content
            if len(file_data) > MAX_FILE_SIZE:
                raise ValueError(
                    f"File exceeds {MAX_FILE_SIZE // (1024 * 1024)}MB size "
                    f"limit ({len(file_data) // (1024 * 1024)}MB)."
                )

            content_type = response.headers.get("content-type", "application/octet-stream")
            content_type = content_type.split(";")[0].strip()

            # Extract filename from Content-Disposition header
            filename = None
            disposition = response.headers.get("content-disposition", "")
            fn_match = re.search(r'filename="?([^";]+)"?', disposition)
            if fn_match:
                filename = fn_match.group(1).strip()

            return file_data, content_type, filename

    async def _request_multipart(
        self,
        path: str,
        file_data: bytes,
        content_type: str,
        filename: str,
    ) -> dict[str, Any]:
        """Upload a file via multipart/form-data with retry + backoff."""
        url = f"{self.base_url}{path}"

        last_status = 0
        last_body = ""

        for attempt in range(MAX_RETRIES):
            await self._throttle()

            async with httpx.AsyncClient(
                headers={"Authorization": f"Bearer {self.token}"},
                timeout=120.0,
            ) as upload_client:
                response = await upload_client.post(
                    url,
                    files={"media": (filename, file_data, content_type)},
                )

            if response.status_code in (200, 201):
                return response.json()

            if response.status_code == 204:
                return {"success": True}

            last_status = response.status_code
            last_body = response.text

            if response.status_code == 429:
                retry_after = response.headers.get("Retry-After")
                wait = max(2**attempt, int(retry_after) if retry_after else 0)
                await asyncio.sleep(wait)
                continue

            if response.status_code >= 500:
                await asyncio.sleep(2**attempt)
                continue

            return {
                "error": response.text,
                "status_code": response.status_code,
            }

        return {
            "error": f"Sprout API returned {last_status} after {MAX_RETRIES} retries",
            "status_code": last_status,
            "sprout_error": last_body,
            "attempts": MAX_RETRIES,
        }

    # --- Tier 1: Core Workflow ---

    async def get_customer_id(self) -> dict:
        return await self._request("GET", "/v1/metadata/client")

    async def list_profiles(self) -> dict:
        return await self._request(
            "GET", f"/v1/{self.customer_id}/metadata/customer"
        )

    async def create_post(
        self,
        profile_ids: list[str],
        text: str,
        group_id: Optional[int] = None,
        scheduled_at: Optional[str] = None,
        media_ids: Optional[list[str]] = None,
        media_types: Optional[list[str]] = None,
        tag_ids: Optional[list[int]] = None,
    ) -> dict:
        body: dict[str, Any] = {
            "is_draft": True,
            "customer_profile_ids": profile_ids,
            "text": text,
        }
        if group_id is not None:
            body["group_id"] = int(group_id)
        if scheduled_at:
            body["delivery"] = {
                "scheduled_times": [scheduled_at],
                "type": "SCHEDULED",
            }
        if media_ids:
            types = media_types or ["PHOTO"] * len(media_ids)
            while len(types) < len(media_ids):
                types.append("PHOTO")
            body["media"] = [
                {"media_id": mid, "media_type": mt}
                for mid, mt in zip(media_ids, types)
            ]
        if tag_ids:
            body["tag_ids"] = tag_ids

        return await self._request(
            "POST", f"/v1/{self.customer_id}/publishing/posts", json=body
        )

    async def get_post(self, post_id: str) -> dict:
        return await self._request(
            "GET", f"/v1/{self.customer_id}/publishing/posts/{post_id}"
        )

    # --- Tier 2: Media, Metadata & Post Management ---

    async def upload_media(self, url: str) -> dict:
        file_id = extract_gdrive_file_id(url)
        if file_id:
            try:
                file_data, content_type, filename = (
                    await self._download_gdrive_file(file_id)
                )
            except (ValueError, PermissionError) as exc:
                return {"error": str(exc)}

            media_type = detect_media_type(content_type, filename)
            if not filename:
                ext_map = {
                    "image/jpeg": ".jpg",
                    "image/png": ".png",
                    "image/gif": ".gif",
                    "image/webp": ".webp",
                    "image/bmp": ".bmp",
                    "video/mp4": ".mp4",
                    "video/quicktime": ".mov",
                    "video/x-msvideo": ".avi",
                    "video/webm": ".webm",
                    "video/mpeg": ".mpeg",
                }
                ext = ext_map.get(content_type, ".bin")
                filename = f"media{ext}"

            result = await self._request_multipart(
                f"/v1/{self.customer_id}/media/",
                file_data,
                content_type,
                filename,
            )
            if "error" not in result:
                result["_detected_media_type"] = media_type
            return result

        return await self._request(
            "POST",
            f"/v1/{self.customer_id}/media/",
            json={"url": url},
        )

    async def list_tags(self) -> dict:
        return await self._request(
            "GET", f"/v1/{self.customer_id}/metadata/customer/tags"
        )

    async def list_users(self) -> dict:
        return await self._request(
            "GET", f"/v1/{self.customer_id}/metadata/customer/users"
        )

    # --- Tier 3: Analytics ---

    async def get_profile_analytics(
        self,
        profile_ids: list[str],
        start_date: str,
        end_date: str,
        metrics: list[str],
    ) -> dict:
        body = {
            "filters": [
                f"customer_profile_id.eq({','.join(profile_ids)})",
                f"reporting_period.in({start_date}...{end_date})",
            ],
            "metrics": metrics,
        }
        return await self._request(
            "POST", f"/v1/{self.customer_id}/analytics/profiles", json=body
        )

    async def get_post_analytics(
        self,
        profile_ids: list[str],
        start_date: str,
        end_date: str,
        metrics: Optional[list[str]] = None,
    ) -> dict:
        if metrics is None:
            metrics = [
                "lifetime.impressions",
                "lifetime.engagements",
                "lifetime.post_link_clicks",
                "lifetime.post_shares_count",
                "lifetime.likes",
                "lifetime.comments_count",
            ]
        body = {
            "filters": [
                f"customer_profile_id.eq({','.join(profile_ids)})",
                f"created_time.in({start_date}T00:00:00..{end_date}T23:59:59)",
            ],
            "fields": [
                "created_time",
                "perma_link",
                "text",
                "internal.sent_by.email",
            ],
            "metrics": metrics,
            "page": 1,
        }

        # Auto-paginate: the posts endpoint returns max 50 results per page.
        all_data: list[dict] = []
        page = 1
        while True:
            body["page"] = page
            result = await self._request(
                "POST", f"/v1/{self.customer_id}/analytics/posts", json=body
            )

            if "error" in result:
                return result

            all_data.extend(result.get("data", []))

            paging = result.get("paging", {})
            if page >= paging.get("total_pages", 1):
                break
            page += 1

        return {
            "data": all_data,
            "paging": {"total_pages": page, "total_results": len(all_data)},
        }
