import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import JamClient from "jmap-jam";

import deno from "../deno.json" with { type: "json" };
import { registerEmailTools } from "./tools/email.ts";
import { registerEmailSubmissionTools } from "./tools/submission.ts";
import { formatError } from "./utils.ts";

const JMAPConfigSchema = z.object({
  sessionUrl: z.string().url().describe("JMAP server session URL"),
  bearerToken: z.string().min(1).describe("Bearer token for authentication"),
  accountId: z.string().optional().describe(
    "Account ID (will be auto-detected if not provided)",
  ),
});

type AccountConfig = {
  name: string;
  bearerToken: string;
  accountId?: string;
};

const parseAccounts = (): AccountConfig[] => {
  // try multi-account first
  const bearerTokens = Deno.env.get("JMAP_BEARER_TOKENS");

  if (bearerTokens) {
    const tokens = bearerTokens.split("\n").map((t) => t.trim()).filter(
      Boolean,
    );

    return tokens.map((token) => {
      const colonIndex = token.indexOf(":");
      if (colonIndex === -1) {
        throw new Error(
          `invalid token format, expected "username:password", got: ${
            token.substring(0, 20)
          }`,
        );
      }

      const name = token.substring(0, colonIndex);
      const bearerToken = token;

      if (!name) {
        throw new Error("account name cannot be empty");
      }

      return { name, bearerToken };
    });
  }

  // fallback to single account (backward compatible)
  const bearerToken = Deno.env.get("JMAP_BEARER_TOKEN");

  if (!bearerToken) {
    throw new Error(
      "missing required environment variables: JMAP_BEARER_TOKEN or JMAP_BEARER_TOKENS",
    );
  }

  // extract account name from username:password format
  const colonIndex = bearerToken.indexOf(":");
  const name = colonIndex !== -1
    ? bearerToken.substring(0, colonIndex)
    : "default";

  return [{ name, bearerToken }];
};

const getJMAPConfig = () => {
  const sessionUrl = Deno.env.get("JMAP_SESSION_URL");

  if (!sessionUrl) {
    throw new Error(
      "missing required environment variable: JMAP_SESSION_URL",
    );
  }

  const accounts = parseAccounts();

  return {
    sessionUrl: JMAPConfigSchema.shape.sessionUrl.parse(sessionUrl),
    accounts,
  };
};

const createJAMClient = (config: z.infer<typeof JMAPConfigSchema>) => {
  // Check if bearerToken contains username:password (Basic Auth format)
  const hasBasicAuth = config.bearerToken.includes(":");

  if (hasBasicAuth) {
    const [username, password] = config.bearerToken.split(":", 2);
    const originalFetch = globalThis.fetch;

    // Monkey-patch fetch to convert Bearer to Basic auth for JMAP requests
    // and fix HTTP apiUrl to HTTPS
    globalThis.fetch = async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.href
        : input.url;

      if (
        url.includes("jmap") ||
        url.includes(new URL(config.sessionUrl).hostname)
      ) {
        const headers = new Headers(init?.headers);

        // Replace Bearer with Basic auth
        if (headers.has("Authorization")) {
          const basicAuth = btoa(`${username}:${password}`);
          headers.set("Authorization", `Basic ${basicAuth}`);
        }

        const response = await originalFetch(input, { ...init, headers });

        // Fix apiUrl in session responses if it's HTTP on port 8080
        if (url.includes("session") || url.includes(".well-known/jmap")) {
          const clonedResponse = response.clone();
          try {
            const json = await clonedResponse.json();
            if (
              json.apiUrl && json.apiUrl.includes("http://") &&
              json.apiUrl.includes(":8080")
            ) {
              // Replace HTTP with HTTPS and remove port
              json.apiUrl = json.apiUrl.replace("http://", "https://").replace(
                ":8080",
                "",
              );
              return new Response(JSON.stringify(json), {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
              });
            }
          } catch {
            // Not JSON, return original
            return response;
          }
        }

        return response;
      }

      return originalFetch(input, init);
    };

    return new JamClient({
      sessionUrl: config.sessionUrl,
      bearerToken: password, // Pass just password
    });
  }

  return new JamClient({
    sessionUrl: config.sessionUrl,
    bearerToken: config.bearerToken,
  });
};

type AccountInfo = {
  name: string;
  jam: JamClient;
  accountId: string;
  isReadOnly: boolean;
  hasSubmission: boolean;
};

type AccountMap = Map<string, AccountInfo>;

const createServer = async () => {
  const config = getJMAPConfig();

  // initialize all accounts
  const accountMap: AccountMap = new Map();

  for (const accountConfig of config.accounts) {
    const jam = createJAMClient({
      sessionUrl: config.sessionUrl,
      bearerToken: accountConfig.bearerToken,
      accountId: accountConfig.accountId,
    });

    const accountId = accountConfig.accountId || await jam.getPrimaryAccount();
    const session = await jam.session;
    const account = session.accounts[accountId];

    if (!("urn:ietf:params:jmap:mail" in session.capabilities)) {
      throw new Error(
        `account "${accountConfig.name}" does not support jmap mail capabilities`,
      );
    }

    const hasSubmission =
      "urn:ietf:params:jmap:submission" in session.capabilities &&
      !account.isReadOnly;

    accountMap.set(accountConfig.name, {
      name: accountConfig.name,
      jam,
      accountId,
      isReadOnly: account.isReadOnly,
      hasSubmission,
    });

    console.warn(
      `initialized account: ${accountConfig.name} (${
        account.isReadOnly ? "read-only" : "read-write"
      })`,
    );
  }

  const firstAccount = accountMap.values().next().value as AccountInfo;
  const hasAnySubmission = Array.from(accountMap.values()).some((a) =>
    a.hasSubmission
  );

  const server = new McpServer({
    name: "jmap",
    version: deno.version,
    capabilities: {
      tools: {},
    },
    instructions:
      `This is a JMAP (JSON Meta Application Protocol) MCP server that provides comprehensive email management capabilities through JMAP-compliant email servers.

**Multi-Account Support:**
This server is configured with ${accountMap.size} account(s): ${
        Array.from(accountMap.keys()).join(", ")
      }. All tools accept an optional \`account\` parameter to specify which account to use. If not specified, the first account (${firstAccount.name}) is used by default.

**Available Tools:**

**Email Search & Retrieval:**
- \`search_emails\`: Search emails with filters (text queries, sender/recipient, date ranges, keywords, mailbox filtering). Supports pagination.
- \`get_emails\`: Retrieve specific emails by ID with full details including headers, body, and attachments.
- \`get_threads\`: Get email conversation threads by ID.

**Mailbox Management:**
- \`get_mailboxes\`: List mailboxes/folders with hierarchy support and pagination.

**Email Actions (when not read-only):**
- \`mark_emails\`: Mark emails as read/unread or flagged/unflagged.
- \`move_emails\`: Move emails between mailboxes.
- \`delete_emails\`: Delete emails permanently (irreversible).

**Email Composition (when not read-only or submission capabilities are not supported):**
- \`send_email\`: Compose and send new emails with support for plain text, HTML, CC/BCC recipients.
- \`reply_to_email\`: Reply to existing emails with reply-all support and proper threading.
- \`create_draft\`: Save email as draft without sending for later review/modification.
- \`update_draft\`: Modify existing draft email (update recipients, subject, body).
- \`send_draft\`: Send a previously saved draft email.

**Usage Guidelines:**
- Drafts allow review before sending - use \`create_draft\` when uncertain about content
- List drafts with \`search_emails({hasKeyword: "$draft"})\`
- Delete drafts with \`delete_emails([draftId])\`
- All tools use pagination - use \`position\` parameter for large result sets
- Email search supports complex filters including keywords like '$seen', '$flagged', '$draft'
- Thread operations maintain conversation context and proper email references
- Send/reply operations require either textBody or htmlBody (or both)
- Date filters use ISO 8601 format (e.g., '2024-01-15T10:00:00Z')

**JMAP Compatibility:**
Works with any JMAP-compliant email server including Cyrus IMAP, Stalwart Mail Server, FastMail, and Apache James. The server automatically detects capabilities and adapts functionality accordingly.`,
  });

  registerEmailTools(server, accountMap);
  console.warn("registered email tools");

  if (hasAnySubmission) {
    registerEmailSubmissionTools(server, accountMap);
    console.warn("registered email submission tools");
  }

  return server;
};

const main = async () => {
  const transport = new StdioServerTransport();

  let server: McpServer;
  try {
    server = await createServer();
  } catch (error) {
    console.error("JMAP connection failed:", formatError(error));
    console.error(
      "Please check your JMAP_SESSION_URL and JMAP_BEARER_TOKEN environment variables.",
    );
    Deno.exit(1);
  }

  await server.connect(transport);
  console.warn("JMAP MCP Server running on stdio");
};

if (import.meta.main) {
  main().catch((error) => {
    console.error("Fatal error in main():", error);
    Deno.exit(1);
  });
}
