#!/usr/bin/env -S deno run --allow-env --allow-net
/**
 * Token-efficient CLI for JMAP email
 * Designed for AI agent interaction with minimal output
 */

import JamClient from "jmap-jam";

const HELP = `jmapper - compact jmap email cli

Commands:
  inbox [n]           Show inbox summary (default: 5 recent)
  unread [n]          Show unread emails
  search <query>      Search emails
  read <id>           Read email body
  from <addr> [n]     Emails from address
  reply <id> <body>   Quick reply
  send <to> <subj>    Send (reads body from stdin)
  mark <id> read|flag Mark email
  ids                 List sender identities
  accounts            List configured accounts
  help                Show this help

Options:
  -a <account>        Use specific account (email or prefix)
  -c                  Compact output (one line per email)
  -t                  TSV output (tab-separated, for agents)

Environment:
  JMAP_SESSION_URL    JMAP server URL (required)
  JMAP_BEARER_TOKEN   Single account: user@example.com:password
  JMAP_BEARER_TOKENS  Multi-account: one user:pass per line

Examples:
  jmapper inbox
  jmapper -c unread 10
  jmapper search "invoice"
  jmapper read abc123
  jmapper -a noc@ inbox
  echo "Thanks!" | jmapper send user@example.com "Re: Hello"
`;

type Config = {
  sessionUrl: string;
  accounts: Array<{ name: string; token: string }>;
};

const getConfig = (): Config => {
  const sessionUrl = Deno.env.get("JMAP_SESSION_URL");
  if (!sessionUrl) throw new Error("JMAP_SESSION_URL not set");

  const tokens = Deno.env.get("JMAP_BEARER_TOKENS") || Deno.env.get("JMAP_BEARER_TOKEN");
  if (!tokens) throw new Error("JMAP_BEARER_TOKEN(S) not set");

  const accounts = tokens.split("\n").filter(Boolean).map((t) => {
    const idx = t.indexOf(":");
    return { name: t.substring(0, idx), token: t };
  });

  return { sessionUrl, accounts };
};

const createClient = async (config: Config, accountName?: string) => {
  let acct = config.accounts[0];

  if (accountName) {
    // Try exact match first, then prefix match
    acct = config.accounts.find((a) => a.name === accountName) ||
           config.accounts.find((a) => a.name.startsWith(accountName)) ||
           undefined as unknown as typeof acct;
  }

  if (!acct) throw new Error(`Account not found: ${accountName}`);

  const [username, password] = acct.token.split(":", 2);
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    if (url.includes("jmap") || url.includes(new URL(config.sessionUrl).hostname)) {
      const headers = new Headers(init?.headers);
      if (headers.has("Authorization")) {
        headers.set("Authorization", `Basic ${btoa(`${username}:${password}`)}`);
      }

      const resp = await originalFetch(input, { ...init, headers });

      if (url.includes("session") || url.includes(".well-known/jmap")) {
        try {
          const json = await resp.clone().json();
          if (json.apiUrl?.includes("http://") && json.apiUrl?.includes(":8080")) {
            json.apiUrl = json.apiUrl.replace("http://", "https://").replace(":8080", "");
            return new Response(JSON.stringify(json), {
              status: resp.status,
              statusText: resp.statusText,
              headers: resp.headers,
            });
          }
        } catch { /* not json */ }
      }
      return resp;
    }
    return originalFetch(input, init);
  };

  const jam = new JamClient({ sessionUrl: config.sessionUrl, bearerToken: password });
  const accountId = await jam.getPrimaryAccount();

  return { jam, accountId, name: acct.name };
};

type Fmt = "human" | "compact" | "tsv";

// TSV header for email listings
const TSV_EMAIL_HEADER = "#flags\tid\tdate\tfrom\tsubject";

// Email formatter
const fmtEmail = (e: Record<string, unknown>, fmt: Fmt): string => {
  const from = ((e.from as Array<{ email: string }>)?.[0]?.email || "?").substring(0, 40);
  const subj = ((e.subject as string) || "(no subject)").substring(0, 60);
  const date = ((e.receivedAt as string) || "").substring(0, 10);
  const read = (e.keywords as Record<string, boolean>)?.["$seen"] ? "" : "*";
  const flag = (e.keywords as Record<string, boolean>)?.["$flagged"] ? "!" : "";
  const flags = `${read}${flag}`.padEnd(2);
  const id = (e.id as string).substring(0, 12);

  if (fmt === "tsv") {
    return `${flags}\t${id}\t${date}\t${from}\t${subj}`;
  }
  if (fmt === "compact") {
    return `${flags} ${id} ${date} ${from.padEnd(25)} ${subj}`;
  }
  return `${flags} [${id}] ${date}\n   From: ${from}\n   Subj: ${subj}`;
};

const fmtPreview = (e: Record<string, unknown>): string => {
  const preview = ((e.preview as string) || "").substring(0, 100);
  return preview ? `   ${preview}...` : "";
};

// Commands
const cmdInbox = async (jam: JamClient, accountId: string, limit: number, fmt: Fmt) => {
  const [mbResult] = await jam.api.Mailbox.query({ accountId, filter: { role: "inbox" } });
  const [mbDetails] = await jam.api.Mailbox.get({ accountId, ids: mbResult.ids });
  const inbox = mbDetails.list[0];

  if (fmt === "tsv") {
    console.log(`#inbox\t${inbox.unreadEmails}\t${inbox.totalEmails}`);
    console.log(TSV_EMAIL_HEADER);
  } else {
    console.log(`Inbox: ${inbox.unreadEmails}/${inbox.totalEmails} unread\n`);
  }

  const [queryResult] = await jam.api.Email.query({
    accountId,
    filter: { inMailbox: inbox.id },
    limit,
    sort: [{ property: "receivedAt", isAscending: false }],
  });

  if (!queryResult.ids.length) return console.log(fmt === "tsv" ? "" : "(empty)");

  const [emails] = await jam.api.Email.get({
    accountId,
    ids: queryResult.ids,
    properties: ["id", "from", "subject", "receivedAt", "keywords", "preview"],
  });

  for (const e of emails.list) {
    console.log(fmtEmail(e, fmt));
    if (fmt === "human") console.log(fmtPreview(e));
  }
};

const cmdUnread = async (jam: JamClient, accountId: string, limit: number, fmt: Fmt) => {
  const [queryResult] = await jam.api.Email.query({
    accountId,
    filter: { notKeyword: "$seen" },
    limit,
    sort: [{ property: "receivedAt", isAscending: false }],
  });

  if (!queryResult.ids.length) return console.log(fmt === "tsv" ? "" : "No unread emails");

  const [emails] = await jam.api.Email.get({
    accountId,
    ids: queryResult.ids,
    properties: ["id", "from", "subject", "receivedAt", "keywords", "preview"],
  });

  if (fmt === "tsv") {
    console.log(`#unread\t${queryResult.total}`);
    console.log(TSV_EMAIL_HEADER);
  } else {
    console.log(`${queryResult.total} unread total\n`);
  }
  for (const e of emails.list) {
    console.log(fmtEmail(e, fmt));
    if (fmt === "human") console.log(fmtPreview(e));
  }
};

const cmdSearch = async (jam: JamClient, accountId: string, query: string, limit: number, fmt: Fmt) => {
  const [queryResult] = await jam.api.Email.query({
    accountId,
    filter: { text: query },
    limit,
    sort: [{ property: "receivedAt", isAscending: false }],
  });

  if (!queryResult.ids.length) return console.log(fmt === "tsv" ? "" : "No results");

  const [emails] = await jam.api.Email.get({
    accountId,
    ids: queryResult.ids,
    properties: ["id", "from", "subject", "receivedAt", "keywords", "preview"],
  });

  if (fmt === "tsv") {
    console.log(`#search\t${queryResult.total}\t${query}`);
    console.log(TSV_EMAIL_HEADER);
  } else {
    console.log(`${queryResult.total} results\n`);
  }
  for (const e of emails.list) {
    console.log(fmtEmail(e, fmt));
    if (fmt === "human") console.log(fmtPreview(e));
  }
};

const cmdFrom = async (jam: JamClient, accountId: string, addr: string, limit: number, fmt: Fmt) => {
  const [queryResult] = await jam.api.Email.query({
    accountId,
    filter: { from: addr },
    limit,
    sort: [{ property: "receivedAt", isAscending: false }],
  });

  if (!queryResult.ids.length) return console.log(fmt === "tsv" ? "" : "No results");

  const [emails] = await jam.api.Email.get({
    accountId,
    ids: queryResult.ids,
    properties: ["id", "from", "subject", "receivedAt", "keywords", "preview"],
  });

  if (fmt === "tsv") {
    console.log(`#from\t${queryResult.total}\t${addr}`);
    console.log(TSV_EMAIL_HEADER);
  } else {
    console.log(`${queryResult.total} from ${addr}\n`);
  }
  for (const e of emails.list) {
    console.log(fmtEmail(e, fmt));
    if (fmt === "human") console.log(fmtPreview(e));
  }
};

const cmdRead = async (jam: JamClient, accountId: string, emailId: string) => {
  const [result] = await jam.api.Email.get({
    accountId,
    ids: [emailId],
    properties: ["id", "from", "to", "cc", "subject", "receivedAt", "textBody", "bodyValues"],
    fetchAllBodyValues: true,
  });

  if (!result.list.length) return console.log("Email not found");

  const e = result.list[0];
  const from = (e.from as Array<{ name?: string; email: string }>)?.map((f) => f.email).join(", ");
  const to = (e.to as Array<{ email: string }>)?.map((t) => t.email).join(", ");

  console.log(`From: ${from}`);
  console.log(`To: ${to}`);
  console.log(`Date: ${e.receivedAt}`);
  console.log(`Subject: ${e.subject}\n`);

  // Get text body
  const textPart = (e.textBody as Array<{ partId: string }>)?.[0];
  if (textPart && e.bodyValues) {
    const body = (e.bodyValues as Record<string, { value: string }>)[textPart.partId]?.value;
    if (body) console.log(body);
  }
};

const cmdMark = async (jam: JamClient, accountId: string, emailId: string, action: string) => {
  const keywords: Record<string, boolean> = {};

  if (action === "read") keywords["$seen"] = true;
  else if (action === "unread") keywords["$seen"] = false;
  else if (action === "flag") keywords["$flagged"] = true;
  else if (action === "unflag") keywords["$flagged"] = false;
  else throw new Error(`Unknown action: ${action}. Use: read, unread, flag, unflag`);

  await jam.api.Email.set({ accountId, update: { [emailId]: { keywords } } });
  console.log(`Marked ${emailId} as ${action}`);
};

const cmdIds = async (jam: JamClient, accountId: string) => {
  const [result] = await jam.api.Identity.get({ accountId });

  for (const id of result.list) {
    console.log(`${id.id.substring(0, 12).padEnd(12)} ${id.email} ${id.name ? `(${id.name})` : ""}`);
  }
};

const cmdAccounts = (config: Config) => {
  console.log("Configured accounts:\n");
  for (const acct of config.accounts) {
    console.log(`  ${acct.name}`);
  }
};

const cmdReply = async (jam: JamClient, accountId: string, emailId: string, body: string) => {
  const [original] = await jam.api.Email.get({
    accountId,
    ids: [emailId],
    properties: ["id", "from", "subject", "replyTo", "messageId"],
  });

  if (!original.list.length) throw new Error("Email not found");

  const orig = original.list[0];
  const replyTo = (orig.replyTo as Array<{ email: string }>)?.[0] || (orig.from as Array<{ email: string }>)?.[0];
  const subject = (orig.subject as string)?.startsWith("Re: ") ? orig.subject : `Re: ${orig.subject}`;

  // Get drafts mailbox
  const [mbResult] = await jam.api.Mailbox.query({ accountId, filter: { role: "drafts" } });
  const [mbDetails] = await jam.api.Mailbox.get({ accountId, ids: mbResult.ids });
  const drafts = mbDetails.list[0];

  // deno-lint-ignore no-explicit-any
  const replyData: any = {
    mailboxIds: drafts ? { [drafts.id]: true } : undefined,
    to: [replyTo],
    subject,
    bodyValues: { text: { value: body, isTruncated: false, isEncodingProblem: false } },
    keywords: { "$draft": true },
    attachments: [],
  };
  if (orig.messageId) replyData.inReplyTo = [orig.messageId];

  const [emailResult] = await jam.api.Email.set({
    accountId,
    create: { "reply1": replyData },
  });

  const draftId = emailResult.created?.reply1?.id;
  if (!draftId) throw new Error("Failed to create reply");

  // Send it
  await jam.api.EmailSubmission.set({
    accountId,
    create: { "sub1": { emailId: draftId } },
  });

  console.log(`Replied to ${replyTo.email}`);
};

const cmdSend = async (jam: JamClient, accountId: string, to: string, subject: string) => {
  // Read body from stdin
  const decoder = new TextDecoder();
  const chunks: Uint8Array[] = [];
  for await (const chunk of Deno.stdin.readable) {
    chunks.push(chunk);
  }
  const body = decoder.decode(new Uint8Array(chunks.flatMap((c) => [...c])));

  if (!body.trim()) throw new Error("Body is empty (pipe text to stdin)");

  // Get drafts mailbox
  const [mbResult] = await jam.api.Mailbox.query({ accountId, filter: { role: "drafts" } });
  const [mbDetails] = await jam.api.Mailbox.get({ accountId, ids: mbResult.ids });
  const drafts = mbDetails.list[0];

  // deno-lint-ignore no-explicit-any
  const emailData: any = {
    mailboxIds: drafts ? { [drafts.id]: true } : undefined,
    to: [{ email: to }],
    subject,
    bodyValues: { text: { value: body, isTruncated: false, isEncodingProblem: false } },
    keywords: { "$draft": true },
    attachments: [],
  };

  const [emailResult] = await jam.api.Email.set({
    accountId,
    create: { "email1": emailData },
  });

  const draftId = emailResult.created?.email1?.id;
  if (!draftId) throw new Error("Failed to create email");

  await jam.api.EmailSubmission.set({
    accountId,
    create: { "sub1": { emailId: draftId } },
  });

  console.log(`Sent to ${to}`);
};

// Main
const main = async () => {
  const args = Deno.args;

  if (args.length === 0 || args[0] === "help" || args[0] === "-h" || args[0] === "--help") {
    console.log(HELP);
    return;
  }

  // Parse options
  let account: string | undefined;
  let fmt: Fmt = "human";
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-a" && args[i + 1]) {
      account = args[++i];
    } else if (args[i] === "-c") {
      fmt = "compact";
    } else if (args[i] === "-t" || args[i] === "--tsv") {
      fmt = "tsv";
    } else {
      positional.push(args[i]);
    }
  }

  const [cmd, ...rest] = positional;

  const config = getConfig();

  // Handle commands that don't need a connection
  if (cmd === "accounts") {
    cmdAccounts(config);
    return;
  }

  const { jam, accountId } = await createClient(config, account);

  switch (cmd) {
    case "inbox":
      await cmdInbox(jam, accountId, parseInt(rest[0]) || 5, fmt);
      break;
    case "unread":
      await cmdUnread(jam, accountId, parseInt(rest[0]) || 10, fmt);
      break;
    case "search":
      await cmdSearch(jam, accountId, rest.join(" "), 20, fmt);
      break;
    case "from":
      await cmdFrom(jam, accountId, rest[0], parseInt(rest[1]) || 10, fmt);
      break;
    case "read":
      await cmdRead(jam, accountId, rest[0]);
      break;
    case "mark":
      await cmdMark(jam, accountId, rest[0], rest[1]);
      break;
    case "ids":
      await cmdIds(jam, accountId);
      break;
    case "reply":
      await cmdReply(jam, accountId, rest[0], rest.slice(1).join(" "));
      break;
    case "send":
      await cmdSend(jam, accountId, rest[0], rest.slice(1).join(" "));
      break;
    default:
      console.error(`Unknown command: ${cmd}`);
      console.log(HELP);
      Deno.exit(1);
  }
};

main().catch((e) => {
  console.error(`Error: ${e.message}`);
  Deno.exit(1);
});
