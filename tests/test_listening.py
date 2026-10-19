from sprout_social_mcp.listening import (
    LISTENING_NETWORKS,
    X_UNAVAILABLE_NOTE,
    build_listening_filters,
    clamp_max_results,
    format_listening_error,
    invalid_dimensions,
    shape_message,
    validate_listening_params,
)

DATES = ("2026-10-12", "2026-10-18")


def test_filters_always_include_inclusive_created_time_range():
    built = build_listening_filters(*DATES)
    assert built.filters[0] == "created_time.in(2026-10-12..2026-10-18T23:59:59)"


def test_networks_default_to_all_listening_networks():
    built = build_listening_filters(*DATES)
    assert built.filters[1] == f"network.eq({','.join(LISTENING_NETWORKS)})"


def test_structured_params_build_filters_in_order():
    built = build_listening_filters(
        *DATES,
        networks=["linkedin", "REDDIT"],
        text_match='"Fireworks AI" OR fireworks.ai',
        sentiment=["Positive", "negative"],
        exclude_profile_ids=[7728503, 7728506],
        filters=["likes.gte(10)"],
    )
    assert built.filters == [
        "created_time.in(2026-10-12..2026-10-18T23:59:59)",
        "network.eq(LINKEDIN,REDDIT)",
        'text.match("Fireworks AI" OR fireworks.ai)',
        "sentiment.eq(positive,negative)",
        "profile.neq(7728503,7728506)",
        "likes.gte(10)",
    ]
    assert built.notes == []


def test_x_and_twitter_dropped_with_note():
    built = build_listening_filters(*DATES, networks=["LINKEDIN", "X", "twitter"])
    assert built.filters[1] == "network.eq(LINKEDIN)"
    assert built.notes == [X_UNAVAILABLE_NOTE]
    assert not built.no_networks_left


def test_x_only_leaves_no_networks():
    built = build_listening_filters(*DATES, networks=["X"])
    assert built.no_networks_left
    assert built.notes == [X_UNAVAILABLE_NOTE]


def test_validation():
    assert validate_listening_params(*DATES) is None
    assert "start_date" in validate_listening_params("10/12/2026", DATES[1])
    assert "on or before" in validate_listening_params("2026-10-18", "2026-10-12")
    assert "happy" in validate_listening_params(*DATES, sentiment=["happy"])


def test_invalid_dimensions():
    assert invalid_dimensions(["created_time.by(day)", "sentiment"]) == []
    assert invalid_dimensions(["created_time.by(week)", "network"]) == ["created_time.by(week)"]


def test_clamp_max_results():
    assert clamp_max_results(None) == 100
    assert clamp_max_results(50) == 50
    assert clamp_max_results(5000) == 500
    assert clamp_max_results(0) == 1


def test_shape_message():
    message = {
        "guid": "li:1",
        "text": "hi",
        "visual_media": [{"url": "https://x"}],
        "listening_metadata": {"sentiment": "positive", "language": "en"},
    }
    assert shape_message(message, False) == {
        "guid": "li:1",
        "text": "hi",
        "sentiment": "positive",
        "listening_metadata": {"language": "en"},
    }
    assert shape_message(message, True)["visual_media"] == [{"url": "https://x"}]
    assert "listening_metadata" not in shape_message(
        {"listening_metadata": {"sentiment": "neutral"}}, False
    )


def test_format_listening_error():
    assert format_listening_error(
        {"error": '{"error":"Topic id is not valid"}', "status_code": 400}
    ) == {"error": "invalid request: Topic id is not valid", "status_code": 400}
    assert format_listening_error(
        {"error": '{"error":"bad value","field":"metrics"}', "status_code": 400}
    ) == {
        "error": "invalid request (field: metrics): bad value",
        "field": "metrics",
        "status_code": 400,
    }
    assert "Listening API" in format_listening_error({"error": "Forbidden", "status_code": 403})["error"]
    assert "rate limit" in format_listening_error({"error": "x", "status_code": 429})["error"]
