#!/usr/bin/env node

/**
 * Sprout Social MCP Server.
 *
 * Exposes Sprout Social API operations as MCP tools for use in Claude Code.
 * Transport: stdio
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { SproutClient } from "./client.js";

// Check for required environment variables
const SPROUT_API_TOKEN = process.env.SPROUT_API_TOKEN;
const SPROUT_CUSTOMER_ID = process.env.SPROUT_CUSTOMER_ID;

if (!SPROUT_API_TOKEN || !SPROUT_CUSTOMER_ID) {
  console.error(
    "Error: SPROUT_API_TOKEN and SPROUT_CUSTOMER_ID environment variables are required."
  );
  console.error(
    "Please set them in your MCP configuration's env block. See README for details."
  );
  process.exit(1);
}

const client = new SproutClient(SPROUT_API_TOKEN, SPROUT_CUSTOMER_ID);
const server = new Server(
  {
    name: "sprout-social-mcp",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Register tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      // Tier 1: Core Workflow
      {
        name: "get_customer_id",
        description:
          "Get your Sprout Social customer ID. Use this during initial setup to find the customer ID needed for all other API calls.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "list_profiles",
        description:
          "List all connected social media profiles (LinkedIn, X/Twitter, Instagram, Facebook, etc.) with their IDs, network types, names, and group IDs. Use this to get profile_ids and group_id for creating posts.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "create_post",
        description:
          "Create a draft social media post in Sprout Social, optionally scheduled.\n\nArgs:\n  profile_ids: List of social profile IDs to post to (from list_profiles).\n  text: The post text content. Network-specific limits are validated by Sprout.\n  group_id: Group ID (from list_profiles). May be required by your account.\n  scheduled_at: ISO 8601 datetime for scheduling (e.g. \"2026-03-20T14:00:00Z\"). If omitted, creates an unscheduled draft.\n  media_ids: List of media IDs from upload_media (must be used within 24hr of upload).\n  media_types: List of media types corresponding to media_ids (\"PHOTO\" or \"VIDEO\"). Defaults to \"PHOTO\". Use _detected_media_type from upload_media response.\n  tag_ids: List of tag IDs from list_tags for organizing/categorizing the post.\n\nNote: Posts are created as drafts. Whether scheduled drafts auto-publish depends on your Sprout account's approval workflow settings.",
        inputSchema: {
          type: "object",
          properties: {
            profile_ids: {
              type: "array",
              items: { type: "string" },
              description:
                "List of social profile IDs to post to (from list_profiles)",
            },
            text: {
              type: "string",
              description: "The post text content",
            },
            group_id: {
              type: "number",
              description: "Group ID (from list_profiles)",
            },
            scheduled_at: {
              type: "string",
              description:
                "ISO 8601 datetime for scheduling (e.g. 2026-03-20T14:00:00Z)",
            },
            media_ids: {
              type: "array",
              items: { type: "string" },
              description: "List of media IDs from upload_media",
            },
            media_types: {
              type: "array",
              items: { type: "string", enum: ["PHOTO", "VIDEO"] },
              description:
                "List of media types corresponding to media_ids (PHOTO or VIDEO). Defaults to PHOTO.",
            },
            tag_ids: {
              type: "array",
              items: { type: "number" },
              description: "List of tag IDs from list_tags",
            },
          },
          required: ["profile_ids", "text"],
        },
      },
      {
        name: "get_post",
        description:
          "Get details and status of a specific post by its ID.\n\nArgs:\n  post_id: The Sprout Social post ID.",
        inputSchema: {
          type: "object",
          properties: {
            post_id: {
              type: "string",
              description: "The Sprout Social post ID",
            },
          },
          required: ["post_id"],
        },
      },
      // Tier 2: Media, Metadata & Post Management
      {
        name: "upload_media",
        description:
          "Upload an image or video to Sprout Social via a public URL or Google Drive link.\n\nSupports:\n- Direct public URLs (passed through to Sprout's API)\n- Google Drive URLs (file is downloaded server-side and uploaded via multipart)\n  Supported formats: drive.google.com/file/d/{ID}/..., drive.google.com/open?id={ID}, drive.usercontent.google.com/download?id={ID}, drive.google.com/uc?export=download&id={ID}\n\nArgs:\n  url: URL of the media file (public URL or Google Drive share link). Must be < 50MB. Google Drive files must have 'Anyone with the link' sharing enabled.\n\nReturns a media_id and detected media_type (PHOTO or VIDEO) that can be used in create_post. The media_id expires 24 hours after upload.",
        inputSchema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description:
                "URL of the media file (public URL or Google Drive share link)",
            },
          },
          required: ["url"],
        },
      },
      {
        name: "list_tags",
        description:
          "List all available tags/labels in Sprout Social for organizing posts. Returns tag IDs that can be passed to create_post's tag_ids parameter.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "list_users",
        description: "List all users on the Sprout Social account.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      // Tier 3: Analytics
      {
        name: "get_profile_analytics",
        description:
          'Get aggregated analytics for social profiles over a date range.\n\nArgs:\n  profile_ids: List of profile IDs to get analytics for.\n  start_date: Start date in YYYY-MM-DD format.\n  end_date: End date in YYYY-MM-DD format.\n  metrics: List of metric names (e.g. ["impressions", "engagements", "followers"]).',
        inputSchema: {
          type: "object",
          properties: {
            profile_ids: {
              type: "array",
              items: { type: "string" },
              description: "List of profile IDs to get analytics for",
            },
            start_date: {
              type: "string",
              description: "Start date in YYYY-MM-DD format",
            },
            end_date: {
              type: "string",
              description: "End date in YYYY-MM-DD format",
            },
            metrics: {
              type: "array",
              items: { type: "string" },
              description: "List of metric names",
            },
          },
          required: ["profile_ids", "start_date", "end_date", "metrics"],
        },
      },
      {
        name: "get_post_analytics",
        description:
          "Get per-post performance metrics over a date range.\n\nReturns individual post data (text, link, author) with lifetime metrics. Automatically fetches all pages (50 posts/page) and returns combined results.\n\nArgs:\n  profile_ids: List of profile IDs to get post analytics for.\n  start_date: Start date in YYYY-MM-DD format.\n  end_date: End date in YYYY-MM-DD format.\n  metrics: List of lifetime-prefixed metric names. Defaults to: lifetime.impressions, lifetime.engagements, lifetime.post_link_clicks, lifetime.post_shares_count, lifetime.likes, lifetime.comments_count. Not all metrics are available on all networks (e.g. YouTube may lack impressions).",
        inputSchema: {
          type: "object",
          properties: {
            profile_ids: {
              type: "array",
              items: { type: "string" },
              description: "List of profile IDs to get post analytics for",
            },
            start_date: {
              type: "string",
              description: "Start date in YYYY-MM-DD format",
            },
            end_date: {
              type: "string",
              description: "End date in YYYY-MM-DD format",
            },
            metrics: {
              type: "array",
              items: { type: "string" },
              description: "List of lifetime-prefixed metric names",
            },
          },
          required: ["profile_ids", "start_date", "end_date"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      // Tier 1: Core Workflow
      case "get_customer_id": {
        const result = await client.getCustomerId();
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "list_profiles": {
        const result = await client.listProfiles();
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "create_post": {
        const {
          profile_ids,
          text,
          group_id,
          scheduled_at,
          media_ids,
          media_types,
          tag_ids,
        } = args as {
          profile_ids: string[];
          text: string;
          group_id?: number;
          scheduled_at?: string;
          media_ids?: string[];
          media_types?: string[];
          tag_ids?: number[];
        };

        if (!profile_ids || profile_ids.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: "profile_ids must not be empty",
                  status_code: 400,
                }),
              },
            ],
          };
        }

        if (!text || !text.trim()) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: "text must not be blank",
                  status_code: 400,
                }),
              },
            ],
          };
        }

        if (
          media_types &&
          media_types.some((mt) => mt !== "PHOTO" && mt !== "VIDEO")
        ) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: "media_types values must be 'PHOTO' or 'VIDEO'",
                  status_code: 400,
                }),
              },
            ],
          };
        }

        const result = await client.createPost(
          profile_ids,
          text,
          group_id,
          scheduled_at,
          media_ids,
          media_types,
          tag_ids
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "get_post": {
        const { post_id } = args as { post_id: string };
        const result = await client.getPost(post_id);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      // Tier 2: Media, Metadata & Post Management
      case "upload_media": {
        const { url } = args as { url: string };
        const result = await client.uploadMedia(url);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "list_tags": {
        const result = await client.listTags();
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "list_users": {
        const result = await client.listUsers();
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      // Tier 3: Analytics
      case "get_profile_analytics": {
        const { profile_ids, start_date, end_date, metrics } = args as {
          profile_ids: string[];
          start_date: string;
          end_date: string;
          metrics: string[];
        };

        if (!profile_ids || profile_ids.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: "profile_ids must not be empty",
                  status_code: 400,
                }),
              },
            ],
          };
        }

        const result = await client.getProfileAnalytics(
          profile_ids,
          start_date,
          end_date,
          metrics
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "get_post_analytics": {
        const { profile_ids, start_date, end_date, metrics } = args as {
          profile_ids: string[];
          start_date: string;
          end_date: string;
          metrics?: string[];
        };

        if (!profile_ids || profile_ids.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: "profile_ids must not be empty",
                  status_code: 400,
                }),
              },
            ],
          };
        }

        const result = await client.getPostAnalytics(
          profile_ids,
          start_date,
          end_date,
          metrics
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: String(error),
            tool: name,
          }),
        },
      ],
      isError: true,
    };
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Sprout Social MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
