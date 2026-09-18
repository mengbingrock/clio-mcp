import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import z from "zod";
import fs from "fs/promises";
import crypto from "crypto";
import { clioGet, clioPost, clioPatch, extractNextPageToken } from "../utils/clioClient.js";
import { appendAuditLog } from "../utils/auditLog.js";

const VERSION_FIELDS = "id,document_id,uuid,version_number,size,filename,content_type,fully_uploaded,created_at";
const DOCUMENT_FIELDS = `id,name,content_type,parent{id,type},matter{id},latest_document_version{${VERSION_FIELDS}}`;
const MAX_BYTES = 50 * 1024 * 1024;
const PART_BYTES = 10 * 1024 * 1024;
const result = (value: unknown, isError = false) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], ...(isError ? { isError } : {}) });
const location = (doc: any) => JSON.stringify([doc.parent?.id, doc.parent?.type, doc.matter?.id ?? null]);

export function registerDocumentVersionTools(server: McpServer): void {
  server.registerTool("list_document_versions", {
    description: "Read one page of version history for an existing Clio document, including incomplete uploads. Follow next_page_token until null.",
    inputSchema: {
      document_id: z.number().int().positive(),
      limit: z.number().int().min(1).max(200).default(100),
      page_token: z.string().optional(),
    },
  }, async ({ document_id, limit, page_token }) => {
    try {
      const response = await clioGet(`/documents/${document_id}/versions.json`, {
        fields: VERSION_FIELDS, limit: String(limit), ...(page_token ? { page_token } : {}),
      });
      if (!Array.isArray(response.data)) throw new Error("Invalid history response");
      const next = extractNextPageToken(response.meta);
      await appendAuditLog({ tool: "list_document_versions", args: { document_id, limit }, outcome: "success", result_count: response.data.length });
      return result({ document_id, versions: response.data, has_more: next !== null, next_page_token: next });
    } catch {
      await appendAuditLog({ tool: "list_document_versions", args: { document_id }, outcome: "error" });
      return result({ error: "Could not read document version history; check access and connection." }, true);
    }
  });

  server.registerTool("upload_document_version", {
    description: "Upload an authorized new revision of an EXISTING document (not a template). Preserves document ID/name/location and previous versions. Requires the latest fully uploaded version UUID observed when the source was downloaded. Max 50 MiB. Preflight is not an atomic edit lock: coordinate other editors. Never blindly retry an uncertain result; inspect version history first.",
    inputSchema: {
      document_id: z.number().int().positive(),
      expected_version_uuid: z.string().min(1),
      file_path: z.string().min(1),
    },
  }, async ({ document_id, expected_version_uuid, file_path }) => {
    let phase = "preflight";
    let uuid: string | null = null;
    let writeAttempted = false;
    try {
      const before = (await clioGet(`/documents/${document_id}.json`, { fields: DOCUMENT_FIELDS })).data;
      if (before?.id !== document_id || !before.parent?.id || !before.parent?.type || !Object.hasOwn(before, "matter") || !before.name || !before.content_type)
        throw new Error("Cannot verify source document");
      if (before.latest_document_version?.uuid !== expected_version_uuid || before.latest_document_version?.fully_uploaded !== true)
        return result({ error: "Source version changed or is not fully uploaded. Download the current document and review again before uploading.", document_id, write_attempted: false }, true);
      const stat = await fs.stat(file_path);
      if (!stat.isFile() || stat.size < 1 || stat.size > MAX_BYTES) throw new Error("Expected a nonempty regular file up to 50 MiB");
      // Freeze the local input once, so edits during upload cannot mix bytes from different revisions.
      const bytes = await fs.readFile(file_path);
      if (bytes.length !== stat.size) throw new Error("Local file changed while reading");
      const parts = [];
      for (let offset = 0; offset < bytes.length; offset += PART_BYTES) {
        const part = bytes.subarray(offset, offset + PART_BYTES);
        parts.push({ part_number: parts.length + 1, content_length: String(part.length), content_md5: crypto.createHash("md5").update(part).digest("base64") });
      }
      phase = "create_version";
      writeAttempted = true;
      const created = (await clioPost("/documents.json?fields=id,latest_document_version{uuid,put_headers,multiparts}", { data: {
        name: before.name, content_type: before.content_type, parent: { type: "Document", id: document_id }, multiparts: parts,
      } })).data;
      uuid = created?.latest_document_version?.uuid ?? null;
      if (created?.id !== document_id || !uuid || uuid === expected_version_uuid) throw new Error("Unexpected document or version identity");
      phase = "upload_parts";
      const version = created.latest_document_version;
      const uploads = version.multiparts;
      if (!Array.isArray(uploads) || uploads.length !== parts.length || new Set(uploads.map((p: any) => p.part_number)).size !== parts.length)
        throw new Error("Incomplete multipart instructions");
      for (const upload of uploads) {
        if (!Number.isInteger(upload.part_number) || upload.part_number < 1 || upload.part_number > parts.length) throw new Error("Invalid part number");
        const url = new URL(upload.put_url);
        if (url.protocol !== "https:" || url.username || url.password || !(url.hostname.endsWith(".amazonaws.com") || url.hostname.endsWith(".amazonaws.com.cn"))) throw new Error("Unexpected storage URL");
        const headers: Record<string, string> = {};
        // Multipart signed requests carry per-part headers; version-level headers
        // describe a single-part PUT and can invalidate the multipart signature.
        for (const h of upload.put_headers ?? []) {
          if (/^(authorization|cookie|host)$/i.test(h.name)) throw new Error("Unexpected storage header");
          headers[h.name] = h.value;
        }
        const offset = (upload.part_number - 1) * PART_BYTES;
        const response = await fetch(url, { method: "PUT", headers, body: bytes.subarray(offset, offset + PART_BYTES), redirect: "error", signal: AbortSignal.timeout(60000) });
        if (!response.ok) throw new Error("Storage upload failed");
      }
      phase = "finalize";
      await clioPatch(`/documents/${document_id}.json?fields=id,latest_document_version{uuid,fully_uploaded}`, { data: { uuid, fully_uploaded: true } });
      phase = "verify";
      const after = (await clioGet(`/documents/${document_id}.json`, { fields: DOCUMENT_FIELDS })).data;
      if (after?.id !== document_id || after.name !== before.name || location(after) !== location(before) || after.latest_document_version?.uuid !== uuid || after.latest_document_version?.fully_uploaded !== true || after.latest_document_version?.size !== bytes.length)
        throw new Error("Readback mismatch");
      await appendAuditLog({ tool: "upload_document_version", args: { document_id }, outcome: "success" });
      return result({ document_id, previous_version_uuid: expected_version_uuid, version_uuid: uuid, version_number: after.latest_document_version.version_number, size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), parent: after.parent, matter: after.matter, verified: true, verification: "Metadata only; download and compare bytes separately for end-to-end acceptance." });
    } catch {
      await appendAuditLog({ tool: "upload_document_version", args: { document_id }, outcome: "error" });
      return result({ error: "Version upload failed or could not be verified", phase, document_id, version_uuid: uuid, write_attempted: writeAttempted, next_step: writeAttempted ? "Do not retry automatically. Read this document and its version history to reconcile any incomplete or completed upload." : "Check current source metadata and local file before retrying." }, true);
    }
  });
}
