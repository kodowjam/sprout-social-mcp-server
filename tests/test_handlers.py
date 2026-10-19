import json

import httpx
import respx

from sprout_social_mcp import handlers
from tests.conftest import BASE, PROFILES

ARGS = {"topic_id": "t1", "start_date": "2026-10-12", "end_date": "2026-10-18"}
TZ = "America/Los_Angeles"
MESSAGES_URL = f"{BASE}/listening/topics/t1/messages"
METRICS_URL = f"{BASE}/listening/topics/t1/metrics"


def body(call):
    return json.loads(call.request.content)


def messages_page(page, total_pages, count):
    return {
        "data": [
            {
                "guid": f"m{page}-{i}",
                "visual_media": [{"url": "https://img"}],
                "listening_metadata": {"sentiment": "positive"},
            }
            for i in range(count)
        ],
        "paging": {"current_page": page, "total_pages": total_pages},
    }


@respx.mock
async def test_messages_paginate_until_max_results(client):
    route = respx.post(MESSAGES_URL).mock(
        side_effect=lambda req: httpx.Response(
            200, json=messages_page(json.loads(req.content)["page"], 5, 100)
        )
    )
    result = await handlers.get_topic_messages(client, TZ, **ARGS, max_results=150)

    assert route.call_count == 2
    assert [(body(c)["page"], body(c)["limit"]) for c in route.calls] == [(1, 100), (2, 100)]
    assert len(result["data"]) == 150
    assert result["paging"]["more_available"] is True
    assert result["data"][0]["sentiment"] == "positive"
    assert "visual_media" not in result["data"][0]
    first = body(route.calls[0])
    assert first["sort"] == ["created_time:desc"]
    assert first["timezone"] == TZ
    assert "from.screen_name" in first["fields"]


@respx.mock
async def test_messages_stop_at_last_page(client):
    route = respx.post(MESSAGES_URL).mock(
        side_effect=lambda req: httpx.Response(
            200,
            json=messages_page(
                json.loads(req.content)["page"], 2, 30 if json.loads(req.content)["page"] == 2 else 100
            ),
        )
    )
    result = await handlers.get_topic_messages(client, TZ, **ARGS, max_results=500)
    assert route.call_count == 2
    assert len(result["data"]) == 130
    assert result["paging"]["more_available"] is False


@respx.mock
async def test_public_only_excludes_owned_profiles(client):
    respx.get(f"{BASE}/metadata/customer").mock(return_value=httpx.Response(200, json=PROFILES))
    route = respx.post(MESSAGES_URL).mock(return_value=httpx.Response(200, json=messages_page(1, 1, 1)))
    await handlers.get_topic_messages(client, TZ, **ARGS, public_only=True)
    assert "profile.neq(7728503,7728506,7738019)" in body(route.calls[0])["filters"]


@respx.mock(assert_all_called=False)
async def test_x_only_returns_note_without_api_call(client):
    result = await handlers.get_topic_messages(client, TZ, **ARGS, networks=["X"])
    assert len(respx.calls) == 0
    assert result["data"] == []
    assert "isn't available" in result["notes"][0]


@respx.mock
async def test_invalid_dimension_rejected_before_api_call(client):
    result = await handlers.get_topic_metrics(
        client, TZ, **ARGS, metrics=["messages_count"], dimensions=["created_time.by(week)"]
    )
    assert len(respx.calls) == 0
    assert result["status_code"] == 400
    assert "created_time.by(week)" in result["error"]


@respx.mock
async def test_metrics_send_dimensions_in_one_request(client):
    rows = [{"dimensions": {"created_time": "2026-10-12", "sentiment": "positive"}, "metrics": {"messages_count": 4}}]
    route = respx.post(METRICS_URL).mock(return_value=httpx.Response(200, json={"data": rows}))
    result = await handlers.get_topic_metrics(
        client, TZ, **ARGS, metrics=["messages_count"],
        dimensions=["created_time.by(day)", "sentiment"], networks=["TWITTER", "LINKEDIN"],
    )
    assert route.call_count == 1
    sent = body(route.calls[0])
    assert sent["dimensions"] == ["created_time.by(day)", "sentiment"]
    assert "network.eq(LINKEDIN)" in sent["filters"]
    assert result["data"] == rows
    assert len(result["notes"]) == 1


@respx.mock
async def test_400_becomes_invalid_request(client):
    respx.post(METRICS_URL).mock(return_value=httpx.Response(400, json={"error": "Topic id is not valid"}))
    result = await handlers.get_topic_metrics(client, TZ, **ARGS, metrics=["messages_count"])
    assert result == {"error": "invalid request: Topic id is not valid", "status_code": 400}


@respx.mock
async def test_429_is_retried(client):
    route = respx.post(METRICS_URL).mock(
        side_effect=[httpx.Response(429, json={}), httpx.Response(200, json={"data": []})]
    )
    result = await handlers.get_topic_metrics(client, TZ, **ARGS, metrics=["messages_count"])
    assert route.call_count == 2
    assert result["data"] == []


@respx.mock
async def test_list_topics_empty_explains(client):
    respx.get(f"{BASE}/metadata/customer/topics").mock(return_value=httpx.Response(200, json={"data": []}))
    result = await handlers.list_listening_topics(client)
    assert "Listening access" in result["note"]


@respx.mock
async def test_document_guard_linkedin_only_passes(client):
    route = respx.get(f"{BASE}/metadata/customer").mock(return_value=httpx.Response(200, json=PROFILES))
    assert await handlers.check_document_profiles(client, ["7728506"], ["DOCUMENT"]) is None
    assert await handlers.check_document_profiles(client, ["7728503"], ["PHOTO"]) is None
    assert route.call_count == 1


@respx.mock
async def test_document_guard_rejects_linkedin_plus_x(client):
    respx.get(f"{BASE}/metadata/customer").mock(return_value=httpx.Response(200, json=PROFILES))
    result = await handlers.check_document_profiles(client, ["7728506", "7728503"], ["DOCUMENT"])
    assert result["status_code"] == 400
    assert result["incompatible_profiles"] == [
        {"profile_id": "7728503", "name": "Fireworks", "network_type": "twitter"}
    ]
    assert all("/publishing/" not in str(c.request.url) for c in respx.calls)
