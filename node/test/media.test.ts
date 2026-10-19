import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { SproutClient } from "../src/client.js";
import { detectMediaType, isPdfBytes } from "../src/media-utils.js";
import { jsonResponse, mockFetch } from "./helpers.js";

const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\n%âãÏÓ\n");
const UPLOAD_OK = { data: [{ media_id: "m-1", expiration_time: "2026-10-20T00:00:00Z" }] };

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

test("detectMediaType: PDFs by magic bytes, MIME type or extension", () => {
  assert.equal(isPdfBytes(PDF_BYTES), true);
  assert.equal(isPdfBytes(new Uint8Array([0x89, 0x50])), false);
  assert.equal(detectMediaType("application/octet-stream", null, PDF_BYTES), "DOCUMENT");
  assert.equal(detectMediaType("application/pdf", null), "DOCUMENT");
  assert.equal(detectMediaType(null, "deck.PDF"), "DOCUMENT");
});

test("detectMediaType: photo and video behavior unchanged", () => {
  assert.equal(detectMediaType("image/png", null), "PHOTO");
  assert.equal(detectMediaType("video/mp4", null), "VIDEO");
  assert.equal(detectMediaType(null, "clip.mov"), "VIDEO");
  assert.equal(detectMediaType("application/octet-stream", "a.jpg"), "PHOTO");
  assert.equal(detectMediaType(null, null), "PHOTO");
});

test("upload_media: public PDF URL returns DOCUMENT", async () => {
  const mock = mockFetch([
    ["GET https://example.com/deck.pdf", () =>
      new Response(PDF_BYTES, {
        status: 206,
        headers: { "content-type": "application/pdf", "content-range": "bytes 0-1023/204800" },
      })],
    ["POST https://api.sproutsocial.com/v1/123/media/", () => jsonResponse(UPLOAD_OK)],
  ]);
  restore = mock.restore;

  const result = await new SproutClient("t", "123").uploadMedia("https://example.com/deck.pdf");
  assert.equal(result._detected_media_type, "DOCUMENT");
  assert.equal(result.data[0].media_id, "m-1");
  // Sprout fetches the file from a multipart media_url part
  assert.equal((mock.calls[1].body as FormData).get("media_url"), "https://example.com/deck.pdf");
});

test("upload_media: public URL over 50MB is rejected before upload", async () => {
  const mock = mockFetch([
    ["GET https://example.com/big.pdf", () =>
      new Response(PDF_BYTES, {
        status: 206,
        headers: { "content-type": "application/pdf", "content-range": `bytes 0-1023/${60 * 1024 * 1024}` },
      })],
  ]);
  restore = mock.restore;
  const result = await new SproutClient("t", "123").uploadMedia("https://example.com/big.pdf");
  assert.match(result.error, /50MB/);
  assert.equal(mock.calls.length, 1);
});

test("upload_media: probe failure still uploads, without a detected type", async () => {
  const mock = mockFetch([
    ["GET https://example.com/a.png", () => new Response("nope", { status: 403 })],
    ["POST https://api.sproutsocial.com/v1/123/media/", () => jsonResponse(UPLOAD_OK)],
  ]);
  restore = mock.restore;
  const result = await new SproutClient("t", "123").uploadMedia("https://example.com/a.png");
  assert.equal(result._detected_media_type, undefined);
  assert.equal(result.data[0].media_id, "m-1");
});

test("upload_media: Google Drive PDF served as octet-stream uploads as application/pdf", async () => {
  const mock = mockFetch([
    ["drive.google.com/uc?export=download&id=FILE123", () =>
      new Response(PDF_BYTES, { status: 200, headers: { "content-type": "application/octet-stream" } })],
    ["POST https://api.sproutsocial.com/v1/123/media/", () => jsonResponse(UPLOAD_OK)],
  ]);
  restore = mock.restore;

  const result = await new SproutClient("t", "123").uploadMedia(
    "https://drive.google.com/file/d/FILE123/view?usp=sharing"
  );
  assert.equal(result._detected_media_type, "DOCUMENT");
  const form = mock.calls[1].body as FormData;
  const file = form.get("media") as File;
  assert.equal(file.type, "application/pdf");
  assert.equal(file.name, "media.pdf");
});
