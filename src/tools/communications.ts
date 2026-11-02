import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import z from "zod";
import { clioGet } from "../utils/clioClient.js";
import { readProvenance } from "../utils/readProvenance.js";
import { appendAuditLog } from "../utils/auditLog.js";

const FIELDS = "id,type,subject,date,received_at,created_at,updated_at,user{id,name},matter{id,display_number},senders{id,type,name},receivers{id,type,name},time_entries_count,time_entries{id,date,quantity_in_hours,quantity_redacted,non_billable,no_charge,contingency_fee}";

export function registerCommunicationTools(server: McpServer): void {
  server.registerTool("list_communications", {
    description: "Read Clio communication records and linked-time IDs. Sender and record user are distinct attributions, not proof of duration or attendance. Follow all pages.",
    inputSchema: {
      matter_id: z.number().int().positive().optional(),
      user_id: z.number().int().positive().optional().describe("Clio's associated record user filter; not a sender filter"),
      received_since: z.string().date().optional(),
      received_before: z.string().date().optional(),
      created_since: z.string().datetime({ offset: true }).optional(),
      updated_since: z.string().datetime({ offset: true }).optional(),
      limit: z.number().int().min(1).max(200).default(25),
      page_token: z.string().optional(),
    },
  }, async (args) => {
    try {
      const params: Record<string, string> = { fields: FIELDS, limit: String(args.limit) };
      for (const [key, value] of Object.entries(args)) if (value !== undefined) params[key] = String(value);
      const response = await clioGet("/communications.json", params);
      const provenance = readProvenance("/communications.json", params, response);
      await appendAuditLog({ tool: "list_communications", args, outcome: "success", result_count: response.data.length });
      return { content: [{ type: "text", text: JSON.stringify({ communications: response.data,
        has_more: provenance.next_page_token !== null, next_page_token: provenance.next_page_token, provenance }) }] };
    } catch (err: any) {
      await appendAuditLog({ tool: "list_communications", args, outcome: "error", error_message: err.message });
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  });
}
