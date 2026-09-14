import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import z from "zod";
import { clioGet, clioPost, clioPatch, clioDelete, extractNextPageToken } from "../utils/clioClient.js";
import { appendAuditLog } from "../utils/auditLog.js";

// Clio Manage v4, not Clio Draft or Carbone's arbitrary JSON merge API.
const TEMPLATE_FIELDS = "id,etag,filename,size,content_type,created_at,updated_at,document_category{id,name}";
const AUTOMATION_FIELDS = "id,etag,state,filename,export_formats,created_at,updated_at,matter{id},document_template{id},documents{id,filename,content_type,size}";
const id = z.number().int().positive();
const filename = z.string().trim().min(1);
// Bound payload memory; callers must supply raw base64, not a data URL.
const file = z.string().min(4).max(28 * 1024 * 1024).refine(
  value => /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value),
  "Provide non-empty, padded base64 file contents (not a data URL)",
);
const pagination = { limit: z.number().int().min(1).max(200).default(25), page_token: z.string().min(1).optional() };

export function registerDocumentTemplateTools(server: McpServer): void {
  // Validate here as well as at the MCP boundary so embedded callers get the same rules.
  function register<S extends z.ZodRawShape>(name: string, description: string, shape: S,
    action: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>) {
    server.registerTool(name, { description, inputSchema: shape as z.ZodRawShape }, async raw => {
      // Never log file contents, filenames, or API error bodies (which can echo payloads).
      const auditArgs = Object.fromEntries(Object.entries(raw).filter(([key]) =>
        ["template_id", "automation_id", "matter_id", "document_category_id", "limit"].includes(key)));
      try {
        const args = z.object(shape).strict().parse(raw);
        const result = await action(args);
        await appendAuditLog({ tool: name, args: auditArgs, outcome: "success" });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        await appendAuditLog({ tool: name, args: auditArgs, outcome: "error", error_message: "Document template operation failed" });
        return { isError: true, content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : "Operation failed"}` }] };
      }
    });
  }

  register("list_document_templates", "List Clio Manage template metadata. Follow next_page_token to retrieve all pages.", pagination, async args => {
    const response = await clioGet("/document_templates.json", {
      fields: TEMPLATE_FIELDS, limit: String(args.limit), ...(args.page_token ? { page_token: args.page_token } : {}),
    });
    const next = extractNextPageToken(response.meta);
    return { templates: response.data, next_page_token: next, has_more: next !== null };
  });
  register("get_document_template", "Read Clio Manage template metadata (not file contents).", { template_id: id }, async args =>
    (await clioGet(`/document_templates/${args.template_id}.json`, { fields: TEMPLATE_FIELDS })).data);

  register("create_document_template", "Upload a Clio Manage merge-field template using base64. Creates a new template; repeated calls create duplicates. Not a Carbone template converter.", {
    file_base64: file, filename, document_category_id: id.optional(),
  }, async args => (await clioPost("/document_templates.json", { data: {
    file: args.file_base64, filename: args.filename,
    ...(args.document_category_id ? { document_category: { id: args.document_category_id } } : {}),
  } }, { fields: TEMPLATE_FIELDS })).data);

  register("update_document_template", "Update an existing template's filename, category or file contents. Read the template first; replacing contents affects future document generation.", {
    template_id: id, file_base64: file.optional(), filename: filename.optional(), document_category_id: id.optional(),
  }, async args => {
    if (!args.file_base64 && !args.filename && !args.document_category_id) throw new Error("Provide at least one field to update");
    if (args.file_base64 && !args.filename) throw new Error("filename is required with file_base64");
    return (await clioPatch(`/document_templates/${args.template_id}.json`, { data: {
      ...(args.file_base64 ? { file: args.file_base64 } : {}),
      ...(args.filename ? { filename: args.filename } : {}),
      ...(args.document_category_id ? { document_category: { id: args.document_category_id } } : {}),
    } }, { fields: TEMPLATE_FIELDS })).data;
  });
  register("delete_document_template", "Delete a Clio Manage template. Requires explicit confirmation; does not delete previously generated documents.", {
    template_id: id, confirm: z.literal(true),
  }, async args => {
    await clioDelete(`/document_templates/${args.template_id}.json`);
    return { deleted: true, template_id: args.template_id };
  });

  register("create_document_automation", "Generate documents from a Clio Manage template and matter merge fields. Returns a job, NOT proof of completion. Read get_document_automation for state and document IDs; then get_document for downloads. Do not blindly retry an uncertain submission: duplicates are possible. No arbitrary JSON merge data is supported.", {
    template_id: id, matter_id: id, filename, formats: z.array(z.enum(["pdf", "original"])).min(1).max(2),
  }, async args => (await clioPost("/document_automations.json", { data: {
    document_template: { id: args.template_id }, matter: { id: args.matter_id },
    filename: args.filename, formats: [...new Set(args.formats)],
  } }, { fields: AUTOMATION_FIELDS })).data);
  register("get_document_automation", "Read generation state and resulting document IDs. A submitted or pending job is not a completed document.", { automation_id: id }, async args =>
    (await clioGet(`/document_automations/${args.automation_id}.json`, { fields: AUTOMATION_FIELDS })).data);
  register("list_document_automations", "List generation jobs to inspect prior submissions before retrying. Follow pagination and compare returned matter/template IDs and filename.", pagination, async args => {
    const response = await clioGet("/document_automations.json", {
      fields: AUTOMATION_FIELDS, limit: String(args.limit), ...(args.page_token ? { page_token: args.page_token } : {}),
    });
    const next = extractNextPageToken(response.meta);
    return { automations: response.data, next_page_token: next, has_more: next !== null };
  });
}
