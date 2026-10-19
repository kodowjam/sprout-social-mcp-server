import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { SproutClient } from "../src/client.js";
import {
  checkDocumentProfiles,
  getTopicMessages,
  getTopicMetrics,
  listListeningTopics,
} from "../src/handlers.js";
import { PROFILES, jsonResponse, mockFetch } from "./helpers.js";

const BASE = { topic_id: "t1", start_date: "2026-10-12", end_date: "2026-10-18" };
const TZ = "America/Los_Angeles";

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

function client() {
  return new SproutClient("token", "123");
}

function messagesPage(page: number, totalPages: number, count: number) {
  return {
    data: Array.from({ length: count }, (_, i) => ({
      guid: `m${page}-${i}`,
      created_time: "2026-10-18T00:00:00Z",
      visual_media: [{ url: "https://img" }],
      listening_metadata: { sentiment: "positive" },
    })),
    paging: { current_page: page, total_pages: totalPages },
  };
}

test("get_topic_messages paginates at 100/page until max_results", async () => {
  const mock = mockFetch([
    ["/listening/topics/t1/messages", (c) => jsonResponse(messagesPage(c.body.page, 5, 100))],
  ]);
  restore = mock.restore;

  const result = await getTopicMessages(client(), { ...BASE, max_results: 150 }, TZ);

  assert.equal(mock.calls.length, 2);
  assert.deepEqual(mock.calls.map((c) => [c.body.page, c.body.limit]), [[1, 100], [2, 100]]);
  assert.equal(result.data.length, 150);
  assert.equal(result.paging.more_available, true);
  // compact shaping
  assert.equal(result.data[0].sentiment, "positive");
  assert.equal(result.data[0].visual_media, undefined);
  // request defaults
  const body = mock.calls[0].body;
  assert.deepEqual(body.sort, ["created_time:desc"]);
  assert.equal(body.timezone, TZ);
  assert.ok(body.fields.includes("from.screen_name"));
  assert.ok(body.fields.includes("sentiment"));
});

test("get_topic_messages stops when current_page == total_pages", async () => {
  const mock = mockFetch([
    ["/listening/topics/t1/messages", (c) => jsonResponse(messagesPage(c.body.page, 2, c.body.page === 2 ? 30 : 100))],
  ]);
  restore = mock.restore;

  const result = await getTopicMessages(client(), { ...BASE, max_results: 500 }, TZ);
  assert.equal(mock.calls.length, 2);
  assert.equal(result.data.length, 130);
  assert.equal(result.paging.more_available, false);
});

test("small max_results requests a smaller page", async () => {
  const mock = mockFetch([
    ["/listening/topics/t1/messages", () => jsonResponse(messagesPage(1, 10, 10))],
  ]);
  restore = mock.restore;
  const result = await getTopicMessages(client(), { ...BASE, max_results: 10 }, TZ);
  assert.equal(mock.calls[0].body.limit, 10);
  assert.equal(result.data.length, 10);
});

test("visual_media is kept when requested as a field", async () => {
  const mock = mockFetch([
    ["/listening/topics/t1/messages", () => jsonResponse(messagesPage(1, 1, 1))],
  ]);
  restore = mock.restore;
  const result = await getTopicMessages(client(), { ...BASE, fields: ["guid", "visual_media"] }, TZ);
  assert.deepEqual(result.data[0].visual_media, [{ url: "https://img" }]);
});

test("public_only excludes every owned profile", async () => {
  const mock = mockFetch([
    ["GET https://api.sproutsocial.com/v1/123/metadata/customer", () => jsonResponse(PROFILES)],
    ["/listening/topics/t1/messages", () => jsonResponse(messagesPage(1, 1, 1))],
  ]);
  restore = mock.restore;

  await getTopicMessages(client(), { ...BASE, public_only: true }, TZ);
  const filters: string[] = mock.calls[1].body.filters;
  assert.ok(filters.includes("profile.neq(7728503,7728506,7738019)"));
});

test("X-only request returns a note without calling the API", async () => {
  const mock = mockFetch([]);
  restore = mock.restore;
  const result = await getTopicMessages(client(), { ...BASE, networks: ["X"] }, TZ);
  assert.equal(mock.calls.length, 0);
  assert.deepEqual(result.data, []);
  assert.match(result.notes[0], /X \(Twitter\) listening data isn't available/);
});

test("X mixed with other networks is dropped and noted", async () => {
  const mock = mockFetch([
    ["/listening/topics/t1/metrics", () => jsonResponse({ data: [] })],
  ]);
  restore = mock.restore;
  const result = await getTopicMetrics(
    client(),
    { ...BASE, metrics: ["messages_count"], networks: ["TWITTER", "LINKEDIN"] },
    TZ
  );
  assert.ok(mock.calls[0].body.filters.includes("network.eq(LINKEDIN)"));
  assert.equal(result.notes.length, 1);
});

test("get_topic_metrics rejects invalid dimensions before any API call", async () => {
  const mock = mockFetch([]);
  restore = mock.restore;
  const result = await getTopicMetrics(
    client(),
    { ...BASE, metrics: ["messages_count"], dimensions: ["created_time.by(week)"] },
    TZ
  );
  assert.equal(mock.calls.length, 0);
  assert.equal(result.status_code, 400);
  assert.match(result.error, /created_time\.by\(week\)/);
});

test("get_topic_metrics sends dimensions and timezone in one request", async () => {
  const rows = [{ dimensions: { created_time: "2026-10-12T00:00:00-07:00", sentiment: "positive" }, metrics: { messages_count: 4 } }];
  const mock = mockFetch([
    ["/listening/topics/t1/metrics", () => jsonResponse({ data: rows })],
  ]);
  restore = mock.restore;
  const result = await getTopicMetrics(
    client(),
    { ...BASE, metrics: ["messages_count"], dimensions: ["created_time.by(day)", "sentiment"], timezone: "UTC" },
    TZ
  );
  assert.equal(mock.calls.length, 1);
  assert.deepEqual(mock.calls[0].body.dimensions, ["created_time.by(day)", "sentiment"]);
  assert.equal(mock.calls[0].body.timezone, "UTC");
  assert.deepEqual(result.data, rows);
});

test("Sprout 400s come back as 'invalid request' with Sprout's message", async () => {
  const mock = mockFetch([
    ["/listening/topics/t1/metrics", () => jsonResponse({ error: "Topic id is not valid" }, 400)],
  ]);
  restore = mock.restore;
  const result = await getTopicMetrics(client(), { ...BASE, metrics: ["messages_count"] }, TZ);
  assert.deepEqual(result, { error: "invalid request: Topic id is not valid", status_code: 400 });
});

test("429 is retried with backoff", async () => {
  let n = 0;
  const mock = mockFetch([
    ["/listening/topics/t1/metrics", () => (++n === 1 ? jsonResponse({}, 429) : jsonResponse({ data: [] }))],
  ]);
  restore = mock.restore;
  const result = await getTopicMetrics(client(), { ...BASE, metrics: ["messages_count"] }, TZ);
  assert.equal(mock.calls.length, 2);
  assert.deepEqual(result.data, []);
});

test("list_listening_topics shapes topics and explains an empty list", async () => {
  let mock = mockFetch([
    ["/metadata/customer/topics", () => jsonResponse({ data: [{ id: "1", name: "Brand", topic_type: "BRAND_HEALTH", description: "", group_id: 9, availability_time: "2020-01-01T00:00:00Z", theme_groups: [{ name: "G", themes: [{ id: "a", name: "A", extra: 1 }] }], extra: true }] })],
  ]);
  restore = mock.restore;
  const result = await listListeningTopics(client());
  assert.deepEqual(result.data[0], {
    id: "1", name: "Brand", topic_type: "BRAND_HEALTH", description: "", group_id: 9,
    theme_groups: [{ name: "G", themes: [{ id: "a", name: "A" }] }],
    availability_time: "2020-01-01T00:00:00Z",
  });
  mock.restore();

  mock = mockFetch([["/metadata/customer/topics", () => jsonResponse({ data: [] })]]);
  restore = mock.restore;
  const empty = await listListeningTopics(client());
  assert.match(empty.note, /Listening access/);
});

test("document guard: LinkedIn-only passes, no lookup for non-documents", async () => {
  const mock = mockFetch([
    ["/metadata/customer", () => jsonResponse(PROFILES)],
  ]);
  restore = mock.restore;
  assert.equal(await checkDocumentProfiles(client(), ["7728506"], ["DOCUMENT"]), null);
  assert.equal(await checkDocumentProfiles(client(), ["7728503"], ["PHOTO"]), null);
  assert.equal(await checkDocumentProfiles(client(), ["7728503"], undefined), null);
  assert.equal(mock.calls.length, 1);
});

test("document guard: LinkedIn + X is rejected naming X", async () => {
  const mock = mockFetch([
    ["/metadata/customer", () => jsonResponse(PROFILES)],
  ]);
  restore = mock.restore;
  const result = await checkDocumentProfiles(client(), ["7728506", "7728503"], ["DOCUMENT"]);
  assert.equal(result!.status_code, 400);
  assert.deepEqual(result!.incompatible_profiles, [
    { profile_id: "7728503", name: "Fireworks", network_type: "twitter" },
  ]);
  // never reached the publishing endpoint
  assert.ok(mock.calls.every((c) => !c.url.includes("/publishing/")));
});

test("document guard: unknown profile IDs are rejected", async () => {
  const mock = mockFetch([["/metadata/customer", () => jsonResponse(PROFILES)]]);
  restore = mock.restore;
  const result = await checkDocumentProfiles(client(), ["999"], ["PHOTO", "DOCUMENT"]);
  assert.deepEqual(result!.incompatible_profiles, [{ profile_id: "999", reason: "profile not found" }]);
});
