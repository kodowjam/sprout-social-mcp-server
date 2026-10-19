import httpx
import respx

from sprout_social_mcp.media_utils import detect_media_type, is_pdf_bytes
from tests.conftest import BASE

PDF_BYTES = b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n"
UPLOAD_OK = {"data": [{"media_id": "m-1", "expiration_time": "2026-10-20T00:00:00Z"}]}


def test_detect_pdf():
    assert is_pdf_bytes(PDF_BYTES)
    assert not is_pdf_bytes(b"\x89PNG")
    assert detect_media_type("application/octet-stream", None, PDF_BYTES) == "DOCUMENT"
    assert detect_media_type("application/pdf", None) == "DOCUMENT"
    assert detect_media_type(None, "deck.PDF") == "DOCUMENT"


def test_photo_video_unchanged():
    assert detect_media_type("image/png", None) == "PHOTO"
    assert detect_media_type("video/mp4", None) == "VIDEO"
    assert detect_media_type(None, "clip.mov") == "VIDEO"
    assert detect_media_type(None, None) == "PHOTO"


@respx.mock
async def test_public_pdf_url_returns_document(client):
    respx.get("https://example.com/deck.pdf").mock(
        return_value=httpx.Response(
            206, content=PDF_BYTES,
            headers={"content-type": "application/pdf", "content-range": "bytes 0-1023/204800"},
        )
    )
    upload = respx.post(f"{BASE}/media/").mock(return_value=httpx.Response(200, json=UPLOAD_OK))
    result = await client.upload_media("https://example.com/deck.pdf")
    assert result["_detected_media_type"] == "DOCUMENT"
    sent = upload.calls[0].request.content
    assert b'name="media_url"' in sent
    assert b"https://example.com/deck.pdf" in sent


@respx.mock
async def test_public_url_over_50mb_rejected(client):
    respx.get("https://example.com/big.pdf").mock(
        return_value=httpx.Response(
            206, content=PDF_BYTES,
            headers={"content-range": f"bytes 0-1023/{60 * 1024 * 1024}"},
        )
    )
    result = await client.upload_media("https://example.com/big.pdf")
    assert "50MB" in result["error"]
    assert len(respx.calls) == 1


@respx.mock
async def test_probe_failure_still_uploads(client):
    respx.get("https://example.com/a.png").mock(return_value=httpx.Response(403))
    respx.post(f"{BASE}/media/").mock(return_value=httpx.Response(200, json=UPLOAD_OK))
    result = await client.upload_media("https://example.com/a.png")
    assert "_detected_media_type" not in result
    assert result["data"][0]["media_id"] == "m-1"


@respx.mock
async def test_drive_pdf_uploads_as_pdf(client):
    respx.get("https://drive.google.com/uc?export=download&id=FILE123").mock(
        return_value=httpx.Response(200, content=PDF_BYTES, headers={"content-type": "application/octet-stream"})
    )
    upload = respx.post(f"{BASE}/media/").mock(return_value=httpx.Response(200, json=UPLOAD_OK))
    result = await client.upload_media("https://drive.google.com/file/d/FILE123/view?usp=sharing")
    assert result["_detected_media_type"] == "DOCUMENT"
    sent = upload.calls[0].request.content
    assert b'filename="media.pdf"' in sent
    assert b"Content-Type: application/pdf" in sent
