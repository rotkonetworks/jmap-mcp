import type JamClient from "jmap-jam";

/** Minimal extension -> MIME map; anything unknown falls back to octet-stream. */
const MIME_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".xml": "application/xml",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx":
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export const mimeForPath = (path: string): string => {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  return MIME_TYPES[name.slice(dot).toLowerCase()] ??
    "application/octet-stream";
};

export type UploadedAttachment = {
  blobId: string;
  type: string;
  name: string;
  size: number;
};

/**
 * Read local files and upload each as a blob, returning the attachment records
 * to place in EmailCreate.attachments.
 *
 * Paths are read from the machine running this MCP server, which for a stdio
 * server is the same machine as the client.
 */
export const uploadAttachments = async (
  jam: JamClient,
  accountId: string,
  paths: string[],
): Promise<UploadedAttachment[]> => {
  const out: UploadedAttachment[] = [];
  for (const path of paths) {
    let data: Uint8Array;
    try {
      data = await Deno.readFile(path);
    } catch (e) {
      throw new Error(
        `cannot read attachment "${path}": ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
    const name = path.split("/").pop() || path;
    const type = mimeForPath(path);
    const blob = await jam.uploadBlob(
      accountId,
      new Blob([data as BlobPart], { type }),
    );
    out.push({ blobId: blob.blobId, type, name, size: data.length });
  }
  return out;
};

/** Resolve the session's downloadUrl template and fill it in for one blob. */
export const buildDownloadUrl = async (
  sessionUrl: string,
  accountId: string,
  blobId: string,
  name: string,
  type: string,
): Promise<string> => {
  const session = await (await fetch(sessionUrl)).json();
  const template = session.downloadUrl as string | undefined;
  if (!template) throw new Error("JMAP session provides no downloadUrl");
  return template
    .replace("{accountId}", accountId)
    .replace("{blobId}", blobId)
    .replace("{name}", encodeURIComponent(name))
    .replace("{type}", encodeURIComponent(type));
};
