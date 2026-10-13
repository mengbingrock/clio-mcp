import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import z from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { clioGet, clioGetAllPages, clioFileDownloadUrl } from "../utils/clioClient.js";
import { getSessionContext, isStdioMode } from "../utils/sessionContext.js";
import { appendAuditLog } from "../utils/auditLog.js";

const id = z.number().int().positive().safe();
const common = {
  output_path: z.string().min(1).optional(),
  max_bytes: z.number().int().min(1).max(512 * 1024 * 1024).default(50 * 1024 * 1024),
};
const versionFields = "id,document_id,uuid,size,filename,content_type,fully_uploaded,created_at";
const templateFields = "id,etag,filename,size,content_type,updated_at";
const documentFields = `id,name,parent{id,type},matter{id},latest_document_version{${versionFields}}`;
const result = (value: unknown, isError = false) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], ...(isError ? { isError } : {}) });

/** Bounded download; no OAuth headers, automatic redirects, or response-body errors. */
export async function fetchDownloadBytes(url: string, expectedSize: number, maxBytes: number): Promise<Buffer> {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error(`Storage download failed (HTTP ${response.status})`);
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    await response.body.cancel(); throw new Error("Storage response exceeds download limit");
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = []; let size = 0;
  try {
    while (true) {
      const item = await reader.read(); if (item.done) break;
      size += item.value.length;
      if (size > maxBytes) throw new Error("Storage response exceeds download limit");
      chunks.push(Buffer.from(item.value));
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  if (size !== expectedSize || size === 0) throw new Error("Downloaded size differs from Clio metadata");
  const bytes = Buffer.concat(chunks);
  if (/^\s*(?:<!doctype\s+html|<html\b)/i.test(bytes.subarray(0, 100).toString("utf8"))) throw new Error("Unexpected HTML response instead of file bytes");
  return bytes;
}

function checkSize(size: unknown, max: number): asserts size is number {
  if (!Number.isSafeInteger(size) || (size as number) <= 0 || (size as number) > max) throw new Error("Missing size or file exceeds download limit");
}
async function checkDestination(output?: string): Promise<void> {
  if (!output) return;
  // A hosted session must never select a path on the shared server filesystem.
  if (!isStdioMode() || getSessionContext()) throw new Error("output_path is only available in local stdio mode; omit it to receive a temporary URL");
  if (!path.isAbsolute(output)) throw new Error("output_path must be absolute");
  const parent = await fs.lstat(path.dirname(output));
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("Destination parent must be an existing regular directory");
  try { await fs.lstat(output); } catch (error: any) { if (error.code === "ENOENT") return; throw error; }
  throw new Error("Destination already exists; choose a new file path");
}

export function registerDocumentDownloadTools(server: McpServer): void {
  function register<S extends z.ZodRawShape>(name: string, description: string, shape: S, action: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>) {
    server.registerTool(name, { description, inputSchema: shape as z.ZodRawShape }, async raw => {
      const auditArgs = Object.fromEntries(Object.entries(raw).filter(([key]) => ["template_id", "document_id", "document_version_id", "max_bytes"].includes(key)));
      try {
        const value = await action(z.object(shape).strict().parse(raw));
        await appendAuditLog({ tool: name, args: auditArgs, outcome: "success" });
        return result(value);
      } catch (error) {
        await appendAuditLog({ tool: name, args: auditArgs, outcome: "error", error_message: "File download failed" });
        // Do not expose raw fetch errors, signed URLs, API bodies, or local filenames.
        const safe = error instanceof Error && /^(Clio download request failed|Expected a Clio|Missing or invalid download|Unrecognized download|Storage download failed|Storage response exceeds|Downloaded size differs|Unexpected HTML|Missing size|output_path|Destination|Template changed|Document changed|Version |Invalid download)/.test(error.message) ? error.message : "Download failed; check connection, object access and selected version.";
        return result({ error: safe }, true);
      }
    });
  }
  async function acquire(args: { output_path?: string; max_bytes: number }, url: string, size: number, verify: () => Promise<void>, metadata: object) {
    if (!args.output_path) {
      await verify();
      return { ...metadata, download_url: url, sensitive_url: true, expires: "temporary; request again if expired", downloaded: false };
    }
    const bytes = await fetchDownloadBytes(url, size, args.max_bytes);
    await verify();
    // Exclusive creation also protects concurrent requests and symlink destinations.
    const file = await fs.open(args.output_path, "wx", 0o600);
    try { await file.writeFile(bytes); await file.sync(); }
    catch (error) { await file.close(); await fs.unlink(args.output_path).catch(() => {}); throw error; }
    await file.close();
    return { ...metadata, downloaded: true, output_path: args.output_path, size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), read_at: new Date().toISOString() };
  }
  register("download_document_template", "Download a Clio template's ORIGINAL bytes, not an automation output. With absolute output_path in local stdio mode, saves exclusively and returns SHA-256; never overwrites. Without output_path, returns a sensitive temporary URL (fetch without Clio OAuth headers). Hosted sessions cannot write server paths. Checks metadata before/after; max 50 MiB by default, up to 512 MiB.", { template_id: id, ...common }, async args => {
    await checkDestination(args.output_path);
    const read = async () => (await clioGet(`/document_templates/${args.template_id}.json`, { fields: templateFields })).data;
    const before = await read();
    if (before?.id !== args.template_id || !before.etag) throw new Error("Invalid download template metadata");
    checkSize(before.size, args.max_bytes);
    const url = await clioFileDownloadUrl("document_templates", args.template_id);
    const verify = async () => { const after = await read(); if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("Template changed during download; acquire a new copy"); };
    return acquire(args, url, before.size, verify, { template_id: before.id, filename: before.filename, content_type: before.content_type, etag: before.etag });
  });
  register("download_document", "Download an existing Clio document's latest fully uploaded version or an explicit numeric document_version_id. Verifies version belongs to this document and preserves ID/UUID provenance. With output_path (local stdio only) saves exclusively and returns SHA-256; otherwise returns a sensitive temporary URL, not downloaded bytes. No Clio writes. Never forwards OAuth to storage. Max 50 MiB by default, up to 512 MiB.", { document_id: id, document_version_id: id.optional(), ...common }, async args => {
    await checkDestination(args.output_path);
    const read = async () => (await clioGet(`/documents/${args.document_id}.json`, { fields: documentFields })).data;
    const before = await read();
    if (before?.id !== args.document_id) throw new Error("Invalid download document metadata");
    async function selected(doc: any) {
      if (args.document_version_id === undefined) return doc.latest_document_version;
      const versions = await clioGetAllPages(`/documents/${args.document_id}/versions.json`, { fields: versionFields, limit: "200" });
      return versions.find((v: any) => v.id === args.document_version_id && v.document_id === args.document_id);
    }
    const version = await selected(before);
    if (!version?.uuid || !Number.isSafeInteger(version.id) || version.fully_uploaded !== true) throw new Error("Version not found on this document or not fully uploaded");
    checkSize(version.size, args.max_bytes);
    const url = await clioFileDownloadUrl("documents", args.document_id, version.id);
    const verify = async () => {
      const after = await read(); const later = await selected(after);
      if (after?.id !== before.id || JSON.stringify(after.parent) !== JSON.stringify(before.parent) || after.matter?.id !== before.matter?.id || JSON.stringify(later) !== JSON.stringify(version))
        throw new Error("Document changed during download; acquire a new copy");
    };
    return acquire(args, url, version.size, verify, { document_id: before.id, document_version_id: version.id, version_uuid: version.uuid, filename: version.filename ?? before.name, content_type: version.content_type, parent: before.parent, matter: before.matter });
  });
}
