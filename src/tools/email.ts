import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type JamClient from "jmap-jam";
import type {
  Email,
  EmailCreate,
  EmailFilterCondition,
  FilterCondition,
  GetEmailArguments,
  MailboxFilterCondition,
} from "jmap-jam";
import { formatError } from "../utils.ts";

type AccountInfo = {
  name: string;
  jam: JamClient;
  accountId: string;
  isReadOnly: boolean;
  hasSubmission: boolean;
};

type AccountMap = Map<string, AccountInfo>;

const accountParam = {
  account: z.string().optional().describe(
    "Account name to use (defaults to first configured account)",
  ),
};

export const SearchEmailsSchema = z.object({
  ...accountParam,
  query: z.string().optional().describe(
    "Text search query to find in email content",
  ),
  from: z.string().optional().describe("Email address to filter messages from"),
  to: z.string().optional().describe("Email address to filter messages to"),
  subject: z.string().optional().describe(
    "Text to search for in email subjects",
  ),
  inMailbox: z.string().optional().describe("Mailbox ID to search within"),
  hasKeyword: z.string().optional().describe(
    "Keyword to filter by (e.g., '$seen', '$flagged')",
  ),
  notKeyword: z.string().optional().describe(
    "Keyword to exclude (e.g., '$seen', '$draft')",
  ),
  before: z.string().datetime().optional().describe(
    "Only return emails before this date (ISO datetime)",
  ),
  after: z.string().datetime().optional().describe(
    "Only return emails after this date (ISO datetime)",
  ),
  limit: z.number().min(1).max(100).default(50).describe(
    "Maximum number of emails to return (1-100, default: 50)",
  ),
  position: z.number().min(0).default(0).describe(
    "Starting position for pagination (default: 0)",
  ),
  allInThreadHaveKeyword: z.string().optional().describe(
    "All Emails (including this one) in the same Thread as this Email must have the given keyword to match the condition.",
  ),
  someInThreadHaveKeyword: z.string().optional().describe(
    "At least one Email (including this one) in the same Thread as this Email must have the given keyword to match the condition.",
  ),
  body: z.string().optional().describe(
    "The server MAY exclude MIME body parts with content media types other than text/* and message/* from consideration in search matching. Care should be taken to match based on the text content actually presented to an end user by viewers for that media type or otherwise identified as appropriate for search indexing. Matching document metadata uninteresting to an end user (e.g., markup tag and attribute names) is undesirable.",
  ),
  fetchDetails: z.boolean().default(false).describe(
    "If true, fetch email details (from, subject, preview) in the same request. More efficient for getting an overview.",
  ),
});

export const GetMailboxesSchema = z.object({
  ...accountParam,
  parentId: z.string().optional().describe("Parent mailbox ID to filter by"),
  limit: z.number().min(1).max(200).default(100).describe(
    "Maximum number of mailboxes to return",
  ),
  position: z.number().min(0).default(0).describe(
    "Starting position for pagination",
  ),
});

export const GetEmailsSchema = z.object({
  ...accountParam,
  ids: z.array(z.string()).min(1).max(50).describe(
    "Array of email IDs to retrieve",
  ),
  properties: z.array(z.enum(
    [
      "id",
      "blobId",
      "threadId",
      "mailboxIds",
      "keywords",
      "size",
      "receivedAt",
      "headers",
      "messageId",
      "inReplyTo",
      "references",
      "sender",
      "from",
      "to",
      "cc",
      "bcc",
      "replyTo",
      "subject",
      "sentAt",
      "bodyStructure",
      "bodyValues",
      "textBody",
      "htmlBody",
      "attachments",
      "hasAttachment",
      "preview",
    ] as const satisfies Array<keyof Email>,
  )).optional().describe(
    "Specific Email properties to return (default: all).",
  ),
});

export const GetThreadsSchema = z.object({
  ...accountParam,
  ids: z.array(z.string()).min(1).max(20).describe(
    "Array of thread IDs to retrieve",
  ),
});

export const MarkEmailsSchema = z.object({
  ...accountParam,
  ids: z.array(z.string()).min(1).max(100).describe(
    "Array of email IDs to mark",
  ),
  seen: z.boolean().optional().describe(
    "Mark as read (true) or unread (false)",
  ),
  flagged: z.boolean().optional().describe(
    "Mark as flagged (true) or unflagged (false)",
  ),
});

export const MoveEmailsSchema = z.object({
  ...accountParam,
  ids: z.array(z.string()).min(1).max(100).describe(
    "Array of email IDs to move",
  ),
  mailboxId: z.string().describe("Target mailbox ID"),
});

export const DeleteEmailsSchema = z.object({
  ...accountParam,
  ids: z.array(z.string()).min(1).max(100).describe(
    "Array of email IDs to delete",
  ),
});

const buildEmailFilter = (args: z.infer<typeof SearchEmailsSchema>) => {
  const filter: EmailFilterCondition = {};

  if (args.query) {
    filter.text = args.query;
  }
  if (args.from) {
    filter.from = args.from;
  }
  if (args.to) {
    filter.to = args.to;
  }
  if (args.subject) {
    filter.subject = args.subject;
  }
  if (args.inMailbox) {
    filter.inMailbox = args.inMailbox;
  }
  if (args.hasKeyword) {
    filter.hasKeyword = args.hasKeyword;
  }
  if (args.notKeyword) {
    filter.notKeyword = args.notKeyword;
  }
  if (args.before) {
    filter.before = args.before;
  }
  if (args.after) {
    filter.after = args.after;
  }
  if (args.allInThreadHaveKeyword) {
    filter.allInThreadHaveKeyword = args.allInThreadHaveKeyword;
  }
  if (args.someInThreadHaveKeyword) {
    filter.someInThreadHaveKeyword = args.someInThreadHaveKeyword;
  }
  if (args.body) {
    filter.body = args.body;
  }

  return Object.keys(filter).length > 0 ? filter : undefined;
};

const getAccount = (
  accountMap: AccountMap,
  requestedAccount?: string,
): AccountInfo => {
  if (requestedAccount) {
    const account = accountMap.get(requestedAccount);
    if (!account) {
      const available = Array.from(accountMap.keys()).join(", ");
      throw new Error(
        `account "${requestedAccount}" not found. available accounts: ${available}`,
      );
    }
    return account;
  }

  // default to first account
  const firstAccount = accountMap.values().next().value;
  if (!firstAccount) {
    throw new Error("no accounts configured");
  }
  return firstAccount;
};

export function registerEmailTools(
  server: McpServer,
  accountMap: AccountMap,
) {
  server.tool(
    "search_emails",
    "Search emails with various filters including text search, sender/recipient filters, date ranges, and keywords. Results are paginated - use position parameter for pagination. Use fetchDetails=true to get email previews in one request.",
    SearchEmailsSchema.shape,
    async (args) => {
      try {
        const { jam, accountId } = getAccount(accountMap, args.account);
        const filter = buildEmailFilter(args);

        const [result] = await jam.api.Email.query({
          accountId,
          filter,
          limit: args.limit,
          position: args.position,
          sort: [{ property: "receivedAt", isAscending: false }],
        });

        // optionally fetch email details in the same request
        let emails: Array<{
          id: string;
          from: string;
          to: string;
          subject: string;
          preview: string;
          receivedAt: string;
          isRead: boolean;
          isFlagged: boolean;
        }> | undefined;

        if (args.fetchDetails && result.ids.length > 0) {
          const [emailResult] = await jam.api.Email.get({
            accountId,
            ids: result.ids,
            properties: ["id", "from", "to", "subject", "preview", "receivedAt", "keywords"],
          });

          emails = emailResult.list.map((e) => ({
            id: e.id,
            from: e.from?.[0]?.email || "unknown",
            to: e.to?.map((t) => t.email).join(", ") || "",
            subject: e.subject || "(no subject)",
            preview: e.preview || "",
            receivedAt: e.receivedAt || "",
            isRead: !!e.keywords?.["$seen"],
            isFlagged: !!e.keywords?.["$flagged"],
          }));
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ids: result.ids,
                  emails,
                  total: result.total,
                  position: result.position,
                  hasMore:
                    result.position + result.ids.length < (result.total || 0),
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error searching emails: ${formatError(error)}`,
            },
          ],
        };
      }
    },
  );

  server.tool(
    "get_mailboxes",
    "Get list of mailboxes/folders. Results are paginated - use position parameter for pagination.",
    GetMailboxesSchema.shape,
    async (args) => {
      try {
        const { jam, accountId } = getAccount(accountMap, args.account);
        let filter: FilterCondition<MailboxFilterCondition> | undefined;
        if (args.parentId) {
          filter = { parentId: args.parentId };
        }

        const [result] = await jam.api.Mailbox.query({
          accountId,
          filter,
          limit: args.limit,
          position: args.position,
          sort: [{ property: "sortOrder", isAscending: true }],
        });

        const [mailboxes] = await jam.api.Mailbox.get({
          accountId,
          ids: result.ids,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  mailboxes: mailboxes.list,
                  total: result.total,
                  position: result.position,
                  hasMore:
                    result.position + result.ids.length < (result.total || 0),
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error getting mailboxes: ${formatError(error)}`,
            },
          ],
        };
      }
    },
  );

  server.tool(
    "get_emails",
    "Get specific emails by their IDs. Returns full email details including headers, body, and attachments.",
    GetEmailsSchema.shape,
    async (args) => {
      try {
        const { jam, accountId } = getAccount(accountMap, args.account);
        const [result] = await jam.api.Email.get(
          {
            accountId,
            ids: args.ids,
            properties: args.properties,
          } satisfies GetEmailArguments,
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  emails: result.list,
                  notFound: result.notFound,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error getting emails: ${formatError(error)}`,
            },
          ],
        };
      }
    },
  );

  server.tool(
    "get_threads",
    "Get email threads by their IDs. A thread contains multiple related emails.",
    GetThreadsSchema.shape,
    async (args) => {
      try {
        const { jam, accountId } = getAccount(accountMap, args.account);
        const [result] = await jam.api.Thread.get({
          accountId,
          ids: args.ids,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  threads: result.list,
                  notFound: result.notFound,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error getting threads: ${formatError(error)}`,
            },
          ],
        };
      }
    },
  );

  // check if any account has write access
  const hasAnyWriteAccess = Array.from(accountMap.values()).some((a) =>
    !a.isReadOnly
  );

  if (hasAnyWriteAccess) {
    server.tool(
      "mark_emails",
      "Mark emails as read/unread or flagged/unflagged. You can update multiple keywords at once. Note: only works with accounts that have write access.",
      MarkEmailsSchema.shape,
      async (args) => {
        try {
          const account = getAccount(accountMap, args.account);

          if (account.isReadOnly) {
            throw new Error(`account "${account.name}" is read-only`);
          }

          const updates: Record<string, EmailCreate> = {};

          for (const id of args.ids) {
            const keywords: Record<string, boolean> = {};

            if (args.seen !== undefined) {
              keywords["$seen"] = args.seen;
            }
            if (args.flagged !== undefined) {
              keywords["$flagged"] = args.flagged;
            }

            updates[id] = { keywords };
          }

          const [result] = await account.jam.api.Email.set({
            accountId: account.accountId,
            update: updates,
          });

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    updated: result.updated,
                    notUpdated: result.notUpdated,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error marking emails: ${formatError(error)}`,
              },
            ],
          };
        }
      },
    );

    server.tool(
      "move_emails",
      "Move emails from their current mailbox to a different mailbox. Note: only works with accounts that have write access.",
      MoveEmailsSchema.shape,
      async (args) => {
        try {
          const account = getAccount(accountMap, args.account);

          if (account.isReadOnly) {
            throw new Error(`account "${account.name}" is read-only`);
          }

          const updates: Record<string, EmailCreate> = {};

          for (const id of args.ids) {
            updates[id] = {
              mailboxIds: { [args.mailboxId]: true },
            };
          }

          const [result] = await account.jam.api.Email.set({
            accountId: account.accountId,
            update: updates,
          });

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    updated: result.updated,
                    notUpdated: result.notUpdated,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error moving emails: ${formatError(error)}`,
              },
            ],
          };
        }
      },
    );

    server.tool(
      "delete_emails",
      "Delete emails permanently. This action cannot be undone. Note: only works with accounts that have write access.",
      DeleteEmailsSchema.shape,
      async (args) => {
        try {
          const account = getAccount(accountMap, args.account);

          if (account.isReadOnly) {
            throw new Error(`account "${account.name}" is read-only`);
          }

          const [result] = await account.jam.api.Email.set({
            accountId: account.accountId,
            destroy: args.ids,
          });

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    destroyed: result.destroyed,
                    notDestroyed: result.notDestroyed,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error deleting emails: ${formatError(error)}`,
              },
            ],
          };
        }
      },
    );
  }

  // identity listing - works for any account
  server.tool(
    "get_identities",
    "List email identities (sender addresses) for an account. Useful for knowing which addresses can be used for sending.",
    z.object({ ...accountParam }).shape,
    async (args) => {
      try {
        const { jam, accountId } = getAccount(accountMap, args.account);

        // get all identities (omitting ids returns all)
        const [result] = await jam.api.Identity.get({
          accountId,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  identities: result.list.map((id) => ({
                    id: id.id,
                    name: id.name,
                    email: id.email,
                    replyTo: id.replyTo,
                    bcc: id.bcc,
                    mayDelete: id.mayDelete,
                  })),
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error getting identities: ${formatError(error)}`,
            },
          ],
        };
      }
    },
  );

  // inbox summary - quick overview for agents
  server.tool(
    "get_inbox_summary",
    "Get a quick summary of inbox status: unread count, total count, and previews of recent unread emails. Efficient for agents to get context.",
    z.object({
      ...accountParam,
      limit: z.number().min(1).max(20).default(5).describe(
        "Number of recent unread emails to preview (1-20, default: 5)",
      ),
    }).shape,
    async (args) => {
      try {
        const { jam, accountId } = getAccount(accountMap, args.account);

        // get inbox mailbox
        const [mailboxResult] = await jam.api.Mailbox.query({
          accountId,
          filter: { role: "inbox" },
        });

        if (!mailboxResult.ids.length) {
          throw new Error("inbox mailbox not found");
        }

        const [mailboxDetails] = await jam.api.Mailbox.get({
          accountId,
          ids: mailboxResult.ids,
        });

        const inbox = mailboxDetails.list[0];

        // get recent unread emails
        const [unreadResult] = await jam.api.Email.query({
          accountId,
          filter: {
            inMailbox: inbox.id,
            notKeyword: "$seen",
          },
          limit: args.limit,
          sort: [{ property: "receivedAt", isAscending: false }],
        });

        // fetch previews for unread
        let recentUnread: Array<{
          id: string;
          from: string;
          subject: string;
          preview: string;
          receivedAt: string;
        }> = [];

        if (unreadResult.ids.length > 0) {
          const [emails] = await jam.api.Email.get({
            accountId,
            ids: unreadResult.ids,
            properties: ["id", "from", "subject", "preview", "receivedAt"],
          });

          recentUnread = emails.list.map((e) => ({
            id: e.id,
            from: e.from?.[0]?.email || "unknown",
            subject: e.subject || "(no subject)",
            preview: e.preview || "",
            receivedAt: e.receivedAt || "",
          }));
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  mailbox: inbox.name,
                  totalEmails: inbox.totalEmails,
                  unreadEmails: inbox.unreadEmails,
                  recentUnread,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error getting inbox summary: ${formatError(error)}`,
            },
          ],
        };
      }
    },
  );

  // list accounts - meta tool for agents
  server.tool(
    "list_accounts",
    "List all configured email accounts and their capabilities. Use this first to understand available accounts.",
    z.object({}).shape,
    async () => {
      const accounts = Array.from(accountMap.values()).map((a) => ({
        name: a.name,
        isReadOnly: a.isReadOnly,
        hasSubmission: a.hasSubmission,
      }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ accounts }, null, 2),
          },
        ],
      };
    },
  );
}
