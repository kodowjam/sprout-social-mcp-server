# Sprout Social MCP Server

An MCP (Model Context Protocol) server that connects Claude to the Sprout Social API for managing social media posts, profiles, analytics, and social listening.

## Features

**Core Workflow**
- `get_customer_id` — Get your Sprout Social customer ID
- `list_profiles` — List all connected social profiles (LinkedIn, X/Twitter, Instagram, Facebook, etc.)
- `create_post` — Create draft posts with optional scheduling, media (photos, videos, PDF documents), and tags
- `get_post` — Get details and status of a specific post

**Media & Metadata**
- `upload_media` — Upload images, videos, and PDFs via public URL or Google Drive link
- `list_tags` — List available tags for organizing posts
- `list_users` — List all users on the account

**Analytics**
- `get_profile_analytics` — Aggregated analytics for social profiles over a date range
- `get_post_analytics` — Per-post performance metrics over a date range

**Listening**
- `list_listening_topics` — List Listening Topics, their themes, and data availability
- `get_topic_messages` — Messages from a Topic with sentiment and engagement, newest first
- `get_topic_metrics` — Aggregate Topic metrics, optionally by day, sentiment, network, etc.

## Prerequisites

- A Sprout Social API token ([developer docs](https://developers.sproutsocial.com/))
- Claude Desktop or Claude Code
- For npx: Node.js 18+ (recommended for most users)
- For uvx: Python 3.10+
- For clone method: Python 3.10+ and git
- For the Listening tools: a Sprout plan with Listening, at least one Listening Topic, and Listening API access for your token. Without these, `list_listening_topics` returns an empty list with a note.

## Installation

Choose one of the following installation methods:

### Option 1: npx (Recommended)

No installation required! Just add this to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "sprout-social": {
      "command": "npx",
      "args": ["-y", "@kodowjam/sprout-social-mcp"],
      "env": {
        "SPROUT_API_TOKEN": "your_sprout_social_api_token_here",
        "SPROUT_CUSTOMER_ID": "your_customer_id_here"
      }
    }
  }
}
```

For Claude Code:

```bash
claude mcp add sprout-social -- npx -y @kodowjam/sprout-social-mcp
```

Then set the environment variables in your shell or MCP config.

> Don't know your customer ID? You can use the `get_customer_id` tool after connecting to find it.

### Option 2: uvx / PyPI

No installation required! Add this to your Claude Desktop config:

```json
{
  "mcpServers": {
    "sprout-social": {
      "command": "uvx",
      "args": ["sprout-social-mcp"],
      "env": {
        "SPROUT_API_TOKEN": "your_sprout_social_api_token_here",
        "SPROUT_CUSTOMER_ID": "your_customer_id_here"
      }
    }
  }
}
```

For Claude Code:

```bash
claude mcp add sprout-social -- uvx sprout-social-mcp
```

Then set the environment variables in your shell or MCP config.

### Option 3: Clone & Install

For development or local customization:

1. Clone and install:

```bash
git clone https://github.com/kodowjam/sprout-social-mcp-server.git
cd sprout-social-mcp-server
pip install .
```

2. Configure environment:

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```
SPROUT_API_TOKEN=your_sprout_social_api_token_here
SPROUT_CUSTOMER_ID=your_customer_id_here
```

3. Connect to Claude Desktop:

```json
{
  "mcpServers": {
    "sprout-social": {
      "command": "python",
      "args": ["server.py"],
      "cwd": "/absolute/path/to/sprout-social-mcp-server"
    }
  }
}
```

For Claude Code:

```bash
claude mcp add sprout-social -- python /absolute/path/to/sprout-social-mcp-server/server.py
```

Restart Claude Desktop to load the server.

## Tools Reference

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `get_customer_id` | Get your Sprout customer ID | — |
| `list_profiles` | List connected social profiles with IDs, networks, and group IDs | — |
| `create_post` | Create a draft post, optionally scheduled | `profile_ids`, `text`, `scheduled_at`, `media_ids`, `tag_ids` |
| `get_post` | Get post details by ID | `post_id` |
| `upload_media` | Upload media from a public URL (expires 24hr unless attached to a post) | `url` |
| `list_tags` | List available tags for organizing posts | — |
| `list_users` | List all account users | — |
| `get_profile_analytics` | Aggregated profile metrics over a date range | `profile_ids`, `start_date`, `end_date`, `metrics` |
| `get_post_analytics` | Per-post metrics over a date range | `profile_ids`, `start_date`, `end_date`, `metrics` |
| `list_listening_topics` | List Listening Topics; their IDs feed the other listening tools | — |
| `get_topic_messages` | Topic messages with sentiment, auto-paginated (default 100, max 500) | `topic_id`, `start_date`, `end_date`, `networks`, `text_match`, `sentiment`, `public_only`, `max_results` |
| `get_topic_metrics` | Aggregate Topic metrics with optional dimensions | `topic_id`, `start_date`, `end_date`, `metrics`, `dimensions` |

### PDF document posts

`upload_media` detects PDFs (by MIME type or the `%PDF` file header) and returns `_detected_media_type: "DOCUMENT"`. Pass that in `create_post`'s `media_types` to create a LinkedIn document post. Sprout silently drops profiles that can't take a document, so `create_post` rejects the call and lists the incompatible profiles if any target isn't a LinkedIn company page or personal profile. Files must be under 50MB.

### Listening notes

- X (Twitter) data isn't available from the Listening API. Requesting `X` or `TWITTER` drops it and returns a note.
- Reddit appears in `get_topic_metrics` but not at message level.
- `public_only: true` excludes posts from all of your connected profiles, leaving earned and public conversation.
- If you don't pass `networks`, all listening networks are queried (the API requires a network filter).

### Optional configuration

| Variable | Default | Used by |
|----------|---------|---------|
| `SPROUT_DEFAULT_TIMEZONE` | `America/Los_Angeles` | Date filters and day/month buckets in the listening tools |

## Development

```bash
# Node
cd node && npm ci && npm test

# Python
pip install -e '.[test]' && pytest
```

## Getting Your API Token

1. Log in to [Sprout Social](https://app.sproutsocial.com/)
2. Navigate to **Settings > API** (or contact your Sprout admin for API access)
3. Generate a new API token
4. See the [Sprout Social API docs](https://developers.sproutsocial.com/) for details

## License

MIT
