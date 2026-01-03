# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## Project Overview

This is a Model Context Protocol (MCP) server that provides JMAP (JSON Meta
Application Protocol) email management tools. It's built with Deno and
integrates with JMAP-compliant email servers like FastMail, Cyrus IMAP, and
Stalwart Mail Server.

## Usage

### Connecting to MCP Clients

To use this server with Claude Desktop or other MCP clients, add it to your MCP
settings configuration.

**Claude Desktop configuration** (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "jmap": {
      "command": "deno",
      "args": [
        "run",
        "--allow-env",
        "--allow-net",
        "/path/to/jmap-mcp/src/mod.ts"
      ],
      "env": {
        "JMAP_SESSION_URL": "https://mail.example.com/.well-known/jmap",
        "JMAP_BEARER_TOKENS": "user1:app-password-1\nuser2:app-password-2"
      }
    }
  }
}
```

**For single account:**

```json
{
  "mcpServers": {
    "jmap": {
      "command": "deno",
      "args": ["run", "--allow-env", "--allow-net", "/path/to/jmap-mcp/src/mod.ts"],
      "env": {
        "JMAP_SESSION_URL": "https://mail.example.com/.well-known/jmap",
        "JMAP_BEARER_TOKEN": "username:app-password"
      }
    }
  }
}
```

### Getting JMAP Credentials

Most JMAP servers use app-specific passwords for authentication:

1. **FastMail**: Settings → Password & Security → App Passwords
2. **Cyrus/Stalwart**: Check your server's documentation for app password
   generation
3. Format: `username:app-password` where username is your email account name

### Available Operations

Once connected, you can ask Claude to perform email operations:

- "search my emails for messages from alice"
- "show me unread emails in the noc account"
- "create a draft email to bob about the outage"
- "send the draft after I review it"
- "mark all emails from github as read"
- "move emails from sender X to archive folder"

All operations support multi-account via the `account` parameter. If not
specified, the first configured account is used.

## Development Commands

### Building and Running

- `deno task start` - Run the MCP server in development
- `deno task watch` - Run with file watching for development

### Testing Connection

- `deno run --allow-env --allow-net src/mod.ts` - Test JMAP server connection

### Required Environment Variables

**Single Account:**

```bash
JMAP_SESSION_URL="https://your-jmap-server.com/.well-known/jmap"
JMAP_BEARER_TOKEN="username:password"
```

**Multi-Account:**

```bash
JMAP_SESSION_URL="https://your-jmap-server.com/.well-known/jmap"
JMAP_BEARER_TOKENS="user1:password1
user2:password2"
```

The server supports both single and multi-account configurations. Account names
are extracted from the username portion of the `username:password` format.

## Architecture

### Core Structure

- **Entry point**: `src/mod.ts` - MCP server setup, multi-account JMAP client
  initialization, and tool registration
- **Tool modules**: `src/tools/` - Modular tool implementations
  - `email.ts` - Email search, retrieval, mailbox management, and basic
    operations
  - `submission.ts` - Email composition and sending (when JMAP submission
    capability is available)
- **Utilities**: `src/utils.ts` - Common utilities like error formatting

### Multi-Account Support

- Server initializes one JMAP client per configured account at startup
- All tools accept an optional `account` parameter to specify which account to
  use
- If no account is specified, the first configured account is used by default
- Account-specific capabilities (read-only, submission) are checked at runtime
- Provides clear error messages when attempting operations on accounts without
  proper capabilities

### Key Design Patterns

- **Functional programming style** - Functions are pure where possible, side
  effects are contained
- **Runtime validation** - All inputs validated with Zod schemas before
  processing
- **Capability-based registration** - Tools are registered based on JMAP server
  capabilities
- **Graceful degradation** - Server adapts to read-only accounts and limited
  JMAP capabilities

### JMAP Integration

- Uses `jmap-jam` client library for JMAP RFC 8620/8621 compliance
- Automatically detects account capabilities and registers appropriate tools
- Supports both read-only and full-access JMAP accounts
- Handles JMAP mail (`urn:ietf:params:jmap:mail`) and submission
  (`urn:ietf:params:jmap:submission`) capabilities

### Tool Categories

All tools support an optional `account` parameter to specify which account to
operate on.

1. **Account & Identity**: `list_accounts`, `get_identities`
2. **Email Search & Retrieval**: `search_emails`, `get_emails`, `get_threads`
3. **Mailbox Management**: `get_mailboxes`, `get_inbox_summary`
4. **Email Actions** (non-read-only): `mark_emails`, `move_emails`,
   `delete_emails`
5. **Email Composition** (submission capability): `send_email`, `reply_to_email`
6. **Draft Management** (non-read-only): `create_draft`, `update_draft`,
   `send_draft`

### Agent-Optimized Tools

For AI agents, these tools provide efficient context gathering:

- `list_accounts` - discover available accounts and their capabilities
- `get_identities` - list sender addresses for composing emails
- `get_inbox_summary` - quick overview with unread count and recent email previews
- `search_emails` with `fetchDetails=true` - search and get previews in one request

## Development Guidelines

### Adding New Tools

1. Create Zod validation schemas for input parameters
2. Implement tool logic with proper error handling using `formatError()`
3. Register tools in appropriate module (`email.ts` vs `submission.ts`)
4. Tools should be registered conditionally based on JMAP capabilities

### Code Style

- Follow functional programming patterns throughout the codebase
- Use TypeScript types imported from `jmap-jam` for JMAP objects
- All external inputs must be validated with Zod schemas
- Error handling should use the `formatError()` utility
- Console output uses `console.warn()` for server status messages

### JMAP Considerations

- Email IDs and thread IDs are server-specific strings, not UUIDs
- Mailbox hierarchies use parent-child relationships via `parentId`
- Keywords like `$seen`, `$flagged`, `$draft` control email state
- Date filters must use ISO 8601 format
- Pagination is handled via `position` and `limit` parameters

## Security Notes

- Bearer tokens are provided via environment variables, never hardcoded
- No secrets are logged or exposed in MCP responses
- Input validation prevents injection attacks
- JMAP protocol provides built-in security through proper authentication
