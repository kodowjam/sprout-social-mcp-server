import pytest

from sprout_social_mcp.client import SproutClient

BASE = "https://api.sproutsocial.com/v1/123"

PROFILES = {
    "data": [
        {"customer_profile_id": 7728503, "network_type": "twitter", "name": "Fireworks", "groups": [2837214]},
        {"customer_profile_id": 7728506, "network_type": "linkedin_company", "name": "Fireworks AI", "groups": [2837214]},
        {"customer_profile_id": 7738019, "network_type": "youtube", "name": "Kodie Dower", "groups": [2837214]},
    ]
}


@pytest.fixture
async def client():
    c = SproutClient(token="token", customer_id="123")
    yield c
    await c.close()
