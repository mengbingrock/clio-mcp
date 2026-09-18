import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import z from "zod";
import { clioGet, clioPost, clioReportDownloadUrl, extractNextPageToken } from "../utils/clioClient.js";
import { appendAuditLog } from "../utils/auditLog.js";

const FIELDS = "id,name,state,kind,format,progress,created_at,updated_at,category,source";
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(
  value => !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value,
  "Expected a real calendar date (YYYY-MM-DD)",
);
export const createReportSchema = z.object({
  kind: z.string().min(1).describe("Clio report kind, e.g. revenue or invoice_payments_v2; Clio validates supported kinds"),
  format: z.enum(["csv", "html", "json", "pdf", "xlsx", "zip"]).default("csv"),
  start_date: date,
  end_date: date,
  client_id: id.optional(),
  matter_id: id.optional(),
  originating_attorney_id: id.optional(),
  responsible_attorney_id: id.optional(),
  practice_area_id: id.optional(),
  user_id: id.optional(),
});

export function registerReportTools(server: McpServer): void {
  function register(name: string, description: string, schema: z.AnyZodObject, run: (args: any) => Promise<unknown>) {
    server.registerTool(name, { description, inputSchema: schema.shape }, async (raw: any) => {
      try {
        const args = schema.parse(raw);
        const result = await run(args);
        // Never log report contents or signed download URLs.
        await appendAuditLog({ tool: name, args, outcome: "success" });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error: any) {
        const message = error.message ?? "Report operation failed";
        await appendAuditLog({ tool: name, args: raw, outcome: "error", error_message: message });
        return { content: [{ type: "text" as const, text: "Error: " + message }], isError: true };
      }
    });
  }

  register("list_reports", "List existing Clio reports (metadata, not revenue totals). Follow next_page_token for remaining results. Creation dates are not the report's accounting period.",
    z.object({
      kind: z.string().optional(), state: z.string().optional(),
      category: z.string().optional(), output_format: z.string().optional(),
      source: z.string().optional(), query: z.string().optional(),
      created_since: z.string().datetime({ offset: true }).optional(),
      created_before: z.string().datetime({ offset: true }).optional(),
      limit: z.number().int().min(1).max(200).default(50),
      page_token: z.string().optional(),
    }), async args => {
      const params: Record<string, string> = { fields: FIELDS };
      for (const [key, value] of Object.entries(args)) if (value !== undefined) params[key] = String(value);
      const response = await clioGet("/reports.json", params);
      const next = extractNextPageToken(response.meta);
      return { reports: response.data, next_page_token: next, has_more: next !== null };
    });

  register("create_report", "Request a new Clio report for explicit start/end dates. Creates a report job, not a payment or invoice. Not available in read-only mode. Do not retry an uncertain create; inspect list_reports first. Use get_report to check completion; formats/permissions depend on Clio.",
    createReportSchema, async args => {
      if (args.start_date > args.end_date) throw new Error("start_date must not be after end_date");
      const data: Record<string, unknown> = { kind: args.kind, format: args.format, start_date: args.start_date, end_date: args.end_date };
      for (const relation of ["client", "matter", "originating_attorney", "responsible_attorney", "practice_area", "user"]) {
        if (args[relation + "_id"] !== undefined) data[relation] = { id: args[relation + "_id"] };
      }
      const result = await clioPost("/reports.json", { data }, { fields: FIELDS });
      return { report: result.data, requested_period: { start_date: args.start_date, end_date: args.end_date } };
    });

  register("get_report", "Read one report's metadata/status. queued/in_progress are not ready, failed is an error, and empty is not proof of zero revenue. No automatic polling or recreation.",
    z.object({ report_id: id }), async ({ report_id }) =>
      (await clioGet("/reports/" + report_id + ".json", { fields: FIELDS })).data);

  register("download_report", "Get the temporary HTTPS download URL for a completed report. Returns a sensitive URL, not file bytes or parsed totals. Retrieve it without Clio OAuth headers; do not publish it. No download until state is completed.",
    z.object({ report_id: id }), async ({ report_id }) => {
      const report = (await clioGet("/reports/" + report_id + ".json", { fields: FIELDS })).data;
      if (report?.state !== "completed") throw new Error("Report is not completed (state: " + (report?.state ?? "unknown") + ")");
      return { report_id, format: report.format, download_url: await clioReportDownloadUrl(report_id), temporary_url: true };
    });
}
