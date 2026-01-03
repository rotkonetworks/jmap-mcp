import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type JamClient from "jmap-jam";
import type { EmailCreate } from "jmap-jam";

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

export const SendEmailSchema = z.object({
  ...accountParam,
  to: z.array(z.object({
    name: z.string().optional().describe("Display name of the recipient"),
    email: z.string().email().describe("Email address of the recipient"),
  })).min(1).describe("Recipients"),
  cc: z.array(z.object({
    name: z.string().optional().describe("Display name of the CC recipient"),
    email: z.string().email().describe("Email address of the CC recipient"),
  })).optional().describe("CC recipients"),
  bcc: z.array(z.object({
    name: z.string().optional().describe("Display name of the BCC recipient"),
    email: z.string().email().describe("Email address of the BCC recipient"),
  })).optional().describe("BCC recipients"),
  subject: z.string().describe("Email subject"),
  textBody: z.string().optional().describe("Plain text body"),
  htmlBody: z.string().optional().describe("HTML body"),
  identityId: z.string().optional().describe("Identity to send from"),
});

export const ReplyToEmailSchema = z.object({
  ...accountParam,
  emailId: z.string().describe("Email ID to reply to"),
  replyAll: z.boolean().default(false).describe("Reply to all recipients"),
  subject: z.string().optional().describe(
    "Reply subject (defaults to Re: original)",
  ),
  textBody: z.string().optional().describe("Plain text body"),
  htmlBody: z.string().optional().describe("HTML body"),
  identityId: z.string().optional().describe("Identity to send from"),
});

export const CreateDraftSchema = z.object({
  ...accountParam,
  to: z.array(z.object({
    name: z.string().optional().describe("Display name of the recipient"),
    email: z.string().email().describe("Email address of the recipient"),
  })).min(1).describe("Recipients"),
  cc: z.array(z.object({
    name: z.string().optional().describe("Display name of the CC recipient"),
    email: z.string().email().describe("Email address of the CC recipient"),
  })).optional().describe("CC recipients"),
  bcc: z.array(z.object({
    name: z.string().optional().describe("Display name of the BCC recipient"),
    email: z.string().email().describe("Email address of the BCC recipient"),
  })).optional().describe("BCC recipients"),
  subject: z.string().describe("Email subject"),
  textBody: z.string().optional().describe("Plain text body"),
  htmlBody: z.string().optional().describe("HTML body"),
  identityId: z.string().optional().describe("Identity to send from"),
});

export const UpdateDraftSchema = z.object({
  ...accountParam,
  draftId: z.string().describe("Draft email ID to update"),
  to: z.array(z.object({
    name: z.string().optional().describe("Display name of the recipient"),
    email: z.string().email().describe("Email address of the recipient"),
  })).optional().describe("Recipients"),
  cc: z.array(z.object({
    name: z.string().optional().describe("Display name of the CC recipient"),
    email: z.string().email().describe("Email address of the CC recipient"),
  })).optional().describe("CC recipients"),
  bcc: z.array(z.object({
    name: z.string().optional().describe("Display name of the BCC recipient"),
    email: z.string().email().describe("Email address of the BCC recipient"),
  })).optional().describe("BCC recipients"),
  subject: z.string().optional().describe("Email subject"),
  textBody: z.string().optional().describe("Plain text body"),
  htmlBody: z.string().optional().describe("HTML body"),
});

export const SendDraftSchema = z.object({
  ...accountParam,
  draftId: z.string().describe("Draft email ID to send"),
  identityId: z.string().optional().describe("Identity to send from"),
});

export function registerEmailSubmissionTools(
  server: McpServer,
  accountMap: AccountMap,
) {
  server.tool(
    "send_email",
    "Send a new email. Requires either textBody or htmlBody (or both). Note: only works with accounts that have submission capabilities.",
    SendEmailSchema.shape,
    async (args) => {
      try {
        const account = getAccount(accountMap, args.account);

        if (!account.hasSubmission) {
          throw new Error(
            `account "${account.name}" does not support email submission`,
          );
        }

        if (!args.textBody && !args.htmlBody) {
          throw new Error("Either textBody or htmlBody must be provided");
        }

        // Get identity email if identityId is provided
        let fromAddress;
        if (args.identityId) {
          const [identityResult] = await account.jam.api.Identity.get({
            accountId: account.accountId,
            ids: [args.identityId],
          });
          const identity = identityResult.list[0];
          if (identity) {
            fromAddress = [{ name: identity.name, email: identity.email }];
          }
        }

        // Get drafts mailbox
        const [mailboxResult] = await account.jam.api.Mailbox.get({
          accountId: account.accountId,
          filter: { role: "drafts" },
        });
        const draftsMailbox = mailboxResult.list[0];

        const emailData = {
          mailboxIds: draftsMailbox ? { [draftsMailbox.id]: true } : undefined,
          subject: args.subject,
          from: fromAddress,
          to: args.to,
          cc: args.cc,
          bcc: args.bcc,
          keywords: { "$draft": true },
          bodyValues: {
            ...(args.textBody && {
              text: {
                value: args.textBody,
                isTruncated: false,
                isEncodingProblem: false,
              },
            }),
            ...(args.htmlBody && {
              html: {
                value: args.htmlBody,
                isTruncated: false,
                isEncodingProblem: false,
              },
            }),
          },
          attachments: [],
        } satisfies EmailCreate;

        const [emailResult] = await account.jam.api.Email.set({
          accountId: account.accountId,
          create: {
            "draft1": emailData,
          },
        });

        if (!emailResult.created?.draft1) {
          throw new Error("Failed to create email draft");
        }

        const [submissionResult] = await account.jam.api.EmailSubmission.set({
          accountId: account.accountId,
          create: {
            "submission1": {
              emailId: emailResult.created.draft1.id,
              identityId: args.identityId,
            },
          },
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  emailId: emailResult.created.draft1.id,
                  submissionId: submissionResult.created?.submission1?.id,
                  sent: !!submissionResult.created?.submission1,
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
              text: `Error sending email: ${formatError(error)}`,
            },
          ],
        };
      }
    },
  );

  server.tool(
    "reply_to_email",
    "Reply to an existing email. Can reply to sender only or reply to all recipients. Note: only works with accounts that have submission capabilities.",
    ReplyToEmailSchema.shape,
    async (args) => {
      try {
        const account = getAccount(accountMap, args.account);

        if (!account.hasSubmission) {
          throw new Error(
            `account "${account.name}" does not support email submission`,
          );
        }

        if (!args.textBody && !args.htmlBody) {
          throw new Error("Either textBody or htmlBody must be provided");
        }

        // Get identity email if identityId is provided
        let fromAddress;
        if (args.identityId) {
          const [identityResult] = await account.jam.api.Identity.get({
            accountId: account.accountId,
            ids: [args.identityId],
          });
          const identity = identityResult.list[0];
          if (identity) {
            fromAddress = [{ name: identity.name, email: identity.email }];
          }
        }

        const [originalEmail] = await account.jam.api.Email.get({
          accountId: account.accountId,
          ids: [args.emailId],
          properties: [
            "id",
            "subject",
            "from",
            "to",
            "cc",
            "replyTo",
            "inReplyTo",
            "references",
          ],
        });

        const original = originalEmail.list[0];
        if (!original) {
          throw new Error("Original email not found");
        }

        const replyTo = original.replyTo && original.replyTo.length > 0
          ? original.replyTo
          : original.from;
        const to = replyTo || [];
        const cc: Array<{ name?: string; email: string }> = [];

        let finalCc = cc;
        if (args.replyAll) {
          if (original.to) {
            finalCc = [...(finalCc || []), ...original.to];
          }
          if (original.cc) {
            finalCc = [...(finalCc || []), ...original.cc];
          }
        }

        const replySubject = args.subject ||
          (original.subject?.startsWith("Re: ")
            ? original.subject
            : `Re: ${original.subject}`);

        // Get drafts mailbox
        const [mailboxResult] = await account.jam.api.Mailbox.get({
          accountId: account.accountId,
          filter: { role: "drafts" },
        });
        const draftsMailbox = mailboxResult.list[0];

        const emailData = {
          mailboxIds: draftsMailbox ? { [draftsMailbox.id]: true } : undefined,
          subject: replySubject,
          from: fromAddress,
          to,
          cc: finalCc,
          keywords: { "$draft": true },
          attachments: [],
          inReplyTo: [original.id],
          references: original.references
            ? (Array.isArray(original.references)
              ? [...original.references, original.id]
              : [original.id])
            : [original.id],
          bodyValues: {
            ...(args.textBody &&
              {
                text: {
                  value: args.textBody,
                  isTruncated: false,
                  isEncodingProblem: false,
                },
              }),
            ...(args.htmlBody &&
              {
                html: {
                  value: args.htmlBody,
                  isTruncated: false,
                  isEncodingProblem: false,
                },
              }),
          },
        };

        const [emailResult] = await account.jam.api.Email.set({
          accountId: account.accountId,
          create: {
            "reply1": emailData,
          },
        });

        if (!emailResult.created?.reply1) {
          throw new Error("Failed to create reply draft");
        }

        const [submissionResult] = await account.jam.api.EmailSubmission.set({
          accountId: account.accountId,
          create: {
            "submission1": {
              emailId: emailResult.created.reply1.id,
              identityId: args.identityId,
            },
          },
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  emailId: emailResult.created.reply1.id,
                  submissionId: submissionResult.created?.submission1?.id,
                  sent: !!submissionResult.created?.submission1,
                  replyAll: args.replyAll,
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
              text: `Error replying to email: ${formatError(error)}`,
            },
          ],
        };
      }
    },
  );

  server.tool(
    "create_draft",
    "Create a new draft email without sending it. Draft can be modified later or sent. Note: only works with accounts that have write access.",
    CreateDraftSchema.shape,
    async (args) => {
      try {
        const account = getAccount(accountMap, args.account);

        if (account.isReadOnly) {
          throw new Error(
            `account "${account.name}" is read-only`,
          );
        }

        if (!args.textBody && !args.htmlBody) {
          throw new Error("either textBody or htmlBody must be provided");
        }

        // get identity email if identityId is provided
        let fromAddress;
        if (args.identityId) {
          const [identityResult] = await account.jam.api.Identity.get({
            accountId: account.accountId,
            ids: [args.identityId],
          });
          const identity = identityResult.list[0];
          if (identity) {
            fromAddress = [{ name: identity.name, email: identity.email }];
          }
        }

        // get drafts mailbox
        const [mailboxResult] = await account.jam.api.Mailbox.get({
          accountId: account.accountId,
          filter: { role: "drafts" },
        });
        const draftsMailbox = mailboxResult.list[0];

        const emailData = {
          mailboxIds: draftsMailbox ? { [draftsMailbox.id]: true } : undefined,
          subject: args.subject,
          from: fromAddress,
          to: args.to,
          cc: args.cc,
          bcc: args.bcc,
          keywords: { "$draft": true },
          bodyValues: {
            ...(args.textBody && {
              text: {
                value: args.textBody,
                isTruncated: false,
                isEncodingProblem: false,
              },
            }),
            ...(args.htmlBody && {
              html: {
                value: args.htmlBody,
                isTruncated: false,
                isEncodingProblem: false,
              },
            }),
          },
          attachments: [],
        } satisfies EmailCreate;

        const [emailResult] = await account.jam.api.Email.set({
          accountId: account.accountId,
          create: {
            "draft1": emailData,
          },
        });

        if (!emailResult.created?.draft1) {
          throw new Error("failed to create draft");
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  draftId: emailResult.created.draft1.id,
                  created: true,
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
              text: `error creating draft: ${formatError(error)}`,
            },
          ],
        };
      }
    },
  );

  server.tool(
    "update_draft",
    "Update an existing draft email. Only updates fields that are provided. Note: only works with accounts that have write access.",
    UpdateDraftSchema.shape,
    async (args) => {
      try {
        const account = getAccount(accountMap, args.account);

        if (account.isReadOnly) {
          throw new Error(
            `account "${account.name}" is read-only`,
          );
        }

        const updates: EmailCreate = {};

        if (args.to !== undefined) updates.to = args.to;
        if (args.cc !== undefined) updates.cc = args.cc;
        if (args.bcc !== undefined) updates.bcc = args.bcc;
        if (args.subject !== undefined) updates.subject = args.subject;

        if (args.textBody || args.htmlBody) {
          updates.bodyValues = {
            ...(args.textBody && {
              text: {
                value: args.textBody,
                isTruncated: false,
                isEncodingProblem: false,
              },
            }),
            ...(args.htmlBody && {
              html: {
                value: args.htmlBody,
                isTruncated: false,
                isEncodingProblem: false,
              },
            }),
          };
        }

        const [emailResult] = await account.jam.api.Email.set({
          accountId: account.accountId,
          update: {
            [args.draftId]: updates,
          },
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  draftId: args.draftId,
                  updated: !!emailResult.updated?.[args.draftId],
                  notUpdated: emailResult.notUpdated?.[args.draftId],
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
              text: `error updating draft: ${formatError(error)}`,
            },
          ],
        };
      }
    },
  );

  server.tool(
    "send_draft",
    "Send a previously saved draft email. Note: only works with accounts that have submission capabilities.",
    SendDraftSchema.shape,
    async (args) => {
      try {
        const account = getAccount(accountMap, args.account);

        if (!account.hasSubmission) {
          throw new Error(
            `account "${account.name}" does not support email submission`,
          );
        }

        // remove draft keyword before sending
        const [updateResult] = await account.jam.api.Email.set({
          accountId: account.accountId,
          update: {
            [args.draftId]: {
              keywords: { "$draft": null },
            },
          },
        });

        if (!updateResult.updated?.[args.draftId]) {
          throw new Error("failed to update draft status");
        }

        const [submissionResult] = await account.jam.api.EmailSubmission.set({
          accountId: account.accountId,
          create: {
            "submission1": {
              emailId: args.draftId,
              identityId: args.identityId,
            },
          },
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  draftId: args.draftId,
                  submissionId: submissionResult.created?.submission1?.id,
                  sent: !!submissionResult.created?.submission1,
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
              text: `error sending draft: ${formatError(error)}`,
            },
          ],
        };
      }
    },
  );
}
