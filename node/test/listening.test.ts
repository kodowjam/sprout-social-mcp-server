import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LISTENING_NETWORKS,
  X_UNAVAILABLE_NOTE,
  buildListeningFilters,
  clampMaxResults,
  formatListeningError,
  invalidDimensions,
  shapeMessage,
  validateListeningParams,
} from "../src/listening.js";

const DATES = { start_date: "2026-10-12", end_date: "2026-10-18" };

test("filters always include an inclusive created_time range", () => {
  const { filters } = buildListeningFilters(DATES);
  assert.equal(filters[0], "created_time.in(2026-10-12..2026-10-18T23:59:59)");
});

test("networks default to all listening networks (API requires a network filter)", () => {
  const { filters } = buildListeningFilters(DATES);
  assert.equal(filters[1], `network.eq(${LISTENING_NETWORKS.join(",")})`);
});

test("structured params build filters in order, raw filters appended as-is", () => {
  const { filters, notes } = buildListeningFilters({
    ...DATES,
    networks: ["linkedin", "REDDIT"],
    text_match: '"Fireworks AI" OR fireworks.ai',
    sentiment: ["Positive", "negative"],
    exclude_profile_ids: [7728503, 7728506],
    filters: ["likes.gte(10)"],
  });
  assert.deepEqual(filters, [
    "created_time.in(2026-10-12..2026-10-18T23:59:59)",
    "network.eq(LINKEDIN,REDDIT)",
    'text.match("Fireworks AI" OR fireworks.ai)',
    "sentiment.eq(positive,negative)",
    "profile.neq(7728503,7728506)",
    "likes.gte(10)",
  ]);
  assert.deepEqual(notes, []);
});

test("X and TWITTER are dropped with a note", () => {
  const { filters, notes, noNetworksLeft } = buildListeningFilters({
    ...DATES,
    networks: ["LINKEDIN", "X", "twitter"],
  });
  assert.equal(filters[1], "network.eq(LINKEDIN)");
  assert.deepEqual(notes, [X_UNAVAILABLE_NOTE]);
  assert.equal(noNetworksLeft, false);
});

test("X-only request leaves no networks", () => {
  const result = buildListeningFilters({ ...DATES, networks: ["X"] });
  assert.equal(result.noNetworksLeft, true);
  assert.deepEqual(result.notes, [X_UNAVAILABLE_NOTE]);
});

test("date and sentiment validation", () => {
  assert.equal(validateListeningParams(DATES), null);
  assert.match(validateListeningParams({ ...DATES, start_date: "10/12/2026" })!, /start_date/);
  assert.match(
    validateListeningParams({ start_date: "2026-10-18", end_date: "2026-10-12" })!,
    /on or before/
  );
  assert.match(validateListeningParams({ ...DATES, sentiment: ["happy"] })!, /happy/);
});

test("invalidDimensions flags anything outside the allowed list", () => {
  assert.deepEqual(invalidDimensions(["created_time.by(day)", "sentiment"]), []);
  assert.deepEqual(invalidDimensions(["created_time.by(week)", "network"]), [
    "created_time.by(week)",
  ]);
});

test("max_results defaults to 100 and is capped at 500", () => {
  assert.equal(clampMaxResults(undefined), 100);
  assert.equal(clampMaxResults(50), 50);
  assert.equal(clampMaxResults(5000), 500);
  assert.equal(clampMaxResults(0), 1);
});

test("shapeMessage flattens sentiment and drops visual_media by default", () => {
  const message = {
    guid: "li:1",
    text: "hi",
    visual_media: [{ url: "https://x" }],
    listening_metadata: { sentiment: "positive", language: "en" },
  };
  assert.deepEqual(shapeMessage(message, false), {
    guid: "li:1",
    text: "hi",
    sentiment: "positive",
    listening_metadata: { language: "en" },
  });
  const kept = shapeMessage(message, true);
  assert.deepEqual(kept.visual_media, [{ url: "https://x" }]);
  assert.equal(
    shapeMessage({ listening_metadata: { sentiment: "neutral" } }, false).listening_metadata,
    undefined
  );
});

test("400 errors become 'invalid request' with Sprout's message and field", () => {
  assert.deepEqual(
    formatListeningError({ error: '{"error":"Topic id is not valid"}', status_code: 400 }),
    { error: "invalid request: Topic id is not valid", status_code: 400 }
  );
  assert.deepEqual(
    formatListeningError({ error: '{"error":"bad value","field":"metrics"}', status_code: 400 }),
    { error: "invalid request (field: metrics): bad value", field: "metrics", status_code: 400 }
  );
  assert.match(
    formatListeningError({ error: "Forbidden", status_code: 403 }).error,
    /Listening API/
  );
  assert.match(formatListeningError({ error: "x", status_code: 429 }).error, /rate limit/);
});
