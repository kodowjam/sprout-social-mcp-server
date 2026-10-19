/**
 * Handlers for the listening tools and the create_post document guard.
 *
 * Kept separate from index.ts (which starts the server on import) so they can
 * be unit tested with a mocked fetch.
 */

import { SproutClient } from "./client.js";
import {
  DEFAULT_MESSAGE_FIELDS,
  DEFAULT_MESSAGE_METRICS,
  ListeningFilterParams,
  buildListeningFilters,
  clampMaxResults,
  formatListeningError,
  invalidDimensions,
  shapeMessage,
  validateListeningParams,
  ALLOWED_DIMENSIONS,
} from "./listening.js";

export const DEFAULT_TIMEZONE = "America/Los_Angeles";

// Sprout network_type values that accept DOCUMENT (PDF) media.
export const DOCUMENT_NETWORK_TYPES = new Set(["linkedin_company", "linkedin"]);

interface CommonListeningArgs {
  topic_id: string;
  start_date: string;
  end_date: string;
  networks?: string[];
  text_match?: string;
  sentiment?: string[];
  public_only?: boolean;
  filters?: string[];
  timezone?: string;
}

export interface TopicMessagesArgs extends CommonListeningArgs {
  fields?: string[];
  metrics?: string[];
  sort?: string[];
  max_results?: number;
}

export interface TopicMetricsArgs extends CommonListeningArgs {
  metrics: string[];
  dimensions?: string[];
}

function badRequest(error: string) {
  return { error: `invalid request: ${error}`, status_code: 400 };
}

/**
 * Validate common args and build the filters array, looking up owned
 * profile IDs when public_only is set.
 */
async function prepareFilters(
  client: SproutClient,
  args: CommonListeningArgs
): Promise<
  | { error: Record<string, any> }
  | { filters: string[]; notes: string[]; noNetworksLeft: boolean }
> {
  if (!args.topic_id) {
    return { error: badRequest("topic_id is required") };
  }

  const params: ListeningFilterParams = {
    start_date: args.start_date,
    end_date: args.end_date,
    networks: args.networks,
    text_match: args.text_match,
    sentiment: args.sentiment,
    filters: args.filters,
  };
  const invalid = validateListeningParams(params);
  if (invalid) {
    return { error: badRequest(invalid) };
  }

  if (args.public_only) {
    const profiles = await client.listProfiles();
    if ("error" in profiles) {
      return { error: formatListeningError(profiles) };
    }
    params.exclude_profile_ids = (profiles.data || []).map(
      (p: any) => p.customer_profile_id
    );
  }

  return buildListeningFilters(params);
}

export async function listListeningTopics(
  client: SproutClient
): Promise<Record<string, any>> {
  const result = await client.listListeningTopics();
  if ("error" in result) {
    return formatListeningError(result);
  }
  const topics = (result.data || []).map((t: any) => ({
    id: t.id,
    name: t.name,
    topic_type: t.topic_type,
    description: t.description,
    group_id: t.group_id,
    theme_groups: (t.theme_groups || []).map((g: any) => ({
      name: g.name,
      themes: (g.themes || []).map((th: any) => ({ id: th.id, name: th.name })),
    })),
    availability_time: t.availability_time,
  }));
  if (!topics.length) {
    return {
      data: [],
      note: "No Listening Topics were returned. Either the account has no Topics, or this API token doesn't have Listening access.",
    };
  }
  return { data: topics };
}

export async function getTopicMessages(
  client: SproutClient,
  args: TopicMessagesArgs,
  defaultTimezone: string
): Promise<Record<string, any>> {
  const prepared = await prepareFilters(client, args);
  if ("error" in prepared) return prepared.error;
  if (prepared.noNetworksLeft) {
    return { data: [], notes: prepared.notes };
  }

  const fields = args.fields?.length ? args.fields : DEFAULT_MESSAGE_FIELDS;
  const metrics = args.metrics?.length ? args.metrics : DEFAULT_MESSAGE_METRICS;
  const keepVisualMedia = fields.includes("visual_media");

  const result = await client.getTopicMessages(
    args.topic_id,
    {
      filters: prepared.filters,
      fields,
      metrics,
      sort: args.sort?.length ? args.sort : ["created_time:desc"],
      timezone: args.timezone || defaultTimezone,
    },
    clampMaxResults(args.max_results)
  );
  if ("error" in result) {
    return formatListeningError(result);
  }

  return {
    data: (result.data || []).map((m: any) => shapeMessage(m, keepVisualMedia)),
    paging: result.paging,
    ...(prepared.notes.length ? { notes: prepared.notes } : {}),
  };
}

export async function getTopicMetrics(
  client: SproutClient,
  args: TopicMetricsArgs,
  defaultTimezone: string
): Promise<Record<string, any>> {
  if (!args.metrics || !args.metrics.length) {
    return badRequest("metrics must not be empty");
  }
  if (args.dimensions?.length) {
    const invalid = invalidDimensions(args.dimensions);
    if (invalid.length) {
      return badRequest(
        `unsupported dimensions: ${invalid.join(", ")}. Allowed: ${ALLOWED_DIMENSIONS.join(", ")}`
      );
    }
  }

  const prepared = await prepareFilters(client, args);
  if ("error" in prepared) return prepared.error;
  if (prepared.noNetworksLeft) {
    return { data: [], notes: prepared.notes };
  }

  const body: {
    filters: string[];
    metrics: string[];
    dimensions?: string[];
    timezone: string;
  } = {
    filters: prepared.filters,
    metrics: args.metrics,
    timezone: args.timezone || defaultTimezone,
  };
  if (args.dimensions?.length) {
    body.dimensions = args.dimensions;
  }

  const result = await client.getTopicMetrics(args.topic_id, body);
  if ("error" in result) {
    return formatListeningError(result);
  }
  return {
    ...result,
    ...(prepared.notes.length ? { notes: prepared.notes } : {}),
  };
}

/**
 * Sprout silently drops profiles that can't take an attached media type.
 * When any media is DOCUMENT, check every target profile accepts documents.
 * Returns an error object to send back, or null if the post can go ahead.
 */
export async function checkDocumentProfiles(
  client: SproutClient,
  profileIds: (string | number)[],
  mediaTypes: string[] | undefined
): Promise<Record<string, any> | null> {
  if (!mediaTypes || !mediaTypes.includes("DOCUMENT")) {
    return null;
  }

  const profiles = await client.listProfiles();
  if ("error" in profiles) {
    return profiles;
  }
  const byId = new Map<string, any>(
    (profiles.data || []).map((p: any) => [String(p.customer_profile_id), p])
  );

  const incompatible = profileIds
    .map((id) => {
      const profile = byId.get(String(id));
      if (!profile) {
        return { profile_id: String(id), reason: "profile not found" };
      }
      if (!DOCUMENT_NETWORK_TYPES.has(profile.network_type)) {
        return {
          profile_id: String(id),
          name: profile.name,
          network_type: profile.network_type,
        };
      }
      return null;
    })
    .filter(Boolean);

  if (!incompatible.length) {
    return null;
  }
  return {
    error:
      "DOCUMENT (PDF) media can only be posted to LinkedIn company pages and personal profiles. Sprout would silently drop the other profiles, so this post was not created. Remove these profiles or the document and try again.",
    incompatible_profiles: incompatible,
    status_code: 400,
  };
}
