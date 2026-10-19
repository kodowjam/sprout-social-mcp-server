/**
 * Listening helpers: filter building, validation and response shaping for
 * the Topic Messages and Topic Metrics endpoints.
 */

export const LISTENING_NETWORKS = [
  "LINKEDIN",
  "REDDIT",
  "YOUTUBE",
  "INSTAGRAM",
  "TIKTOK",
  "WWW",
  "BLUESKY",
  "FACEBOOK",
  "TUMBLR",
];

// X data is not returned by the Listening API.
const X_NETWORKS = new Set(["TWITTER", "X"]);

export const X_UNAVAILABLE_NOTE =
  "X (Twitter) listening data isn't available via the Sprout API, so X was left out of this request.";

export const SENTIMENTS = ["positive", "negative", "neutral", "unclassified"];

export const ALLOWED_DIMENSIONS = [
  "created_time.by(day)",
  "created_time.by(month)",
  "visual_media.media_type",
  "distribution_type",
  "network",
  "sentiment",
  "language",
  "explicit_label",
  "location.city",
  "location.province",
  "location.country",
];

export const DEFAULT_MESSAGE_FIELDS = [
  "guid",
  "created_time",
  "network",
  "text",
  "perma_link",
  "from.name",
  "from.screen_name",
  "content_category",
  "language",
  "sentiment",
];

export const DEFAULT_MESSAGE_METRICS = [
  "engagements",
  "likes",
  "replies",
  "shares_count",
  "impressions",
  "from.followers_count",
];

export const MESSAGES_PAGE_SIZE = 100; // API max
export const DEFAULT_MAX_RESULTS = 100;
export const MAX_RESULTS_CAP = 500;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface ListeningFilterParams {
  start_date: string;
  end_date: string;
  networks?: string[];
  text_match?: string;
  sentiment?: string[];
  exclude_profile_ids?: (string | number)[];
  filters?: string[];
}

export interface BuiltFilters {
  filters: string[];
  notes: string[];
  // True when the caller only asked for networks the API can't serve (X).
  noNetworksLeft: boolean;
}

/**
 * Validate the structured params shared by both listening tools.
 * Returns an error message, or null if valid.
 */
export function validateListeningParams(
  params: ListeningFilterParams
): string | null {
  if (!DATE_RE.test(params.start_date || "")) {
    return "start_date must be in YYYY-MM-DD format";
  }
  if (!DATE_RE.test(params.end_date || "")) {
    return "end_date must be in YYYY-MM-DD format";
  }
  if (params.start_date > params.end_date) {
    return "start_date must be on or before end_date";
  }
  if (params.sentiment) {
    const bad = params.sentiment.filter(
      (s) => !SENTIMENTS.includes(s.toLowerCase())
    );
    if (bad.length) {
      return `sentiment values must be one of ${SENTIMENTS.join(", ")} (got ${bad.join(", ")})`;
    }
  }
  return null;
}

/**
 * Build the Listening filters array from structured params.
 *
 * Always includes a created_time range. The API requires a network or
 * profile filter, so when networks is omitted all listening networks are used.
 */
export function buildListeningFilters(
  params: ListeningFilterParams
): BuiltFilters {
  const notes: string[] = [];
  const filters = [
    `created_time.in(${params.start_date}..${params.end_date}T23:59:59)`,
  ];

  let networks = LISTENING_NETWORKS;
  if (params.networks && params.networks.length) {
    const requested = params.networks.map((n) => n.trim().toUpperCase());
    networks = requested.filter((n) => !X_NETWORKS.has(n));
    if (networks.length < requested.length) {
      notes.push(X_UNAVAILABLE_NOTE);
    }
    if (!networks.length) {
      return { filters, notes, noNetworksLeft: true };
    }
  }
  filters.push(`network.eq(${networks.join(",")})`);

  if (params.text_match && params.text_match.trim()) {
    filters.push(`text.match(${params.text_match.trim()})`);
  }
  if (params.sentiment && params.sentiment.length) {
    filters.push(
      `sentiment.eq(${params.sentiment.map((s) => s.toLowerCase()).join(",")})`
    );
  }
  if (params.exclude_profile_ids && params.exclude_profile_ids.length) {
    filters.push(`profile.neq(${params.exclude_profile_ids.join(",")})`);
  }
  if (params.filters) {
    filters.push(...params.filters);
  }

  return { filters, notes, noNetworksLeft: false };
}

/**
 * Return the dimensions that aren't in ALLOWED_DIMENSIONS.
 */
export function invalidDimensions(dimensions: string[]): string[] {
  return dimensions.filter((d) => !ALLOWED_DIMENSIONS.includes(d));
}

/**
 * Clamp max_results to 1..MAX_RESULTS_CAP, defaulting to DEFAULT_MAX_RESULTS.
 */
export function clampMaxResults(maxResults?: number): number {
  if (maxResults === undefined || maxResults === null || isNaN(maxResults)) {
    return DEFAULT_MAX_RESULTS;
  }
  return Math.max(1, Math.min(MAX_RESULTS_CAP, Math.floor(maxResults)));
}

/**
 * Compact a listening message for LLM context: flatten
 * listening_metadata.sentiment to a top-level sentiment and drop
 * visual_media unless the caller asked for it.
 */
export function shapeMessage(
  message: Record<string, any>,
  keepVisualMedia: boolean
): Record<string, any> {
  const shaped: Record<string, any> = { ...message };
  const meta = shaped.listening_metadata;
  if (meta && typeof meta === "object") {
    if (meta.sentiment !== undefined && shaped.sentiment === undefined) {
      shaped.sentiment = meta.sentiment;
    }
    const rest = { ...meta };
    delete rest.sentiment;
    if (Object.keys(rest).length) {
      shaped.listening_metadata = rest;
    } else {
      delete shaped.listening_metadata;
    }
  }
  if (!keepVisualMedia) {
    delete shaped.visual_media;
  }
  return shaped;
}

/**
 * Turn a Sprout error result ({error, status_code}) into a clearer error for
 * the listening tools. Passes Sprout's message through; 400s become
 * "invalid request", naming the field when Sprout provides one.
 */
export function formatListeningError(result: Record<string, any>): Record<string, any> {
  const status = result.status_code;
  if (status === 429) {
    return {
      error:
        "Sprout rate limit hit (60 requests/minute) and retries were exhausted. Wait a minute and try again, or request fewer results.",
      status_code: 429,
    };
  }
  let message: string = result.error ?? "Unknown error";
  let field: string | undefined;

  try {
    const parsed = JSON.parse(message);
    if (parsed && typeof parsed === "object") {
      message = parsed.error ?? parsed.message ?? message;
      field = parsed.field ?? parsed.parameter ?? undefined;
    }
  } catch {
    // Not JSON; use the raw text.
  }
  if (typeof message !== "string") message = JSON.stringify(message);

  if (status === 400) {
    return {
      error: `invalid request${field ? ` (field: ${field})` : ""}: ${message}`,
      ...(field ? { field } : {}),
      status_code: 400,
    };
  }
  if (status === 401 || status === 403) {
    return {
      error: `Sprout denied access to the Listening API: ${message}. Listening API access must be enabled for this token.`,
      status_code: status,
    };
  }
  return { ...result, error: message };
}
