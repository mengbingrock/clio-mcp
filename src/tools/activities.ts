import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import z from "zod";
import { clioGet, clioPost, extractNextPageToken } from "../utils/clioClient.js";
import { appendAuditLog } from "../utils/auditLog.js";

const ACTIVITY_FIELDS = "id,type,date,quantity_in_hours,quantity_redacted,price,total,note,non_billable,no_charge,matter{id,display_number},task{id},user{id,name}";
const TASK_RECORDED_TIME_FIELDS =
  "id,time_entries_count,time_entries{id,date,quantity_in_hours,quantity_redacted,price,total,note,non_billable,no_charge}";

function shapeTimeEntry(entry: any) {
  return {
    id: entry.id,
    date: entry.date ?? null,
    quantity_in_hours: entry.quantity_in_hours ?? null,
    quantity_redacted: entry.quantity_redacted ?? false,
    rate: entry.price ?? null,
    total: entry.total ?? null,
    note: entry.note ?? null,
    non_billable: entry.non_billable ?? false,
    no_charge: entry.no_charge ?? false,
  };
}

async function verifyTaskRecordedTime(taskId: number, activityId: number) {
  try {
    const data = await clioGet(`/tasks/${taskId}.json`, { fields: TASK_RECORDED_TIME_FIELDS });
    const task = data.data;
    const recordedEntry = (task.time_entries ?? []).find((entry: any) => entry.id === activityId);
    return {
      task_id: taskId,
      verified: recordedEntry !== undefined,
      time_entries_count: task.time_entries_count ?? null,
      recorded_time_entry: recordedEntry ? shapeTimeEntry(recordedEntry) : null,
      ...(recordedEntry === undefined && {
        warning: "The time entry was created, but the immediate task read-back did not include it in Recorded Time.",
      }),
    };
  } catch (err: any) {
    return {
      task_id: taskId,
      verified: false,
      time_entries_count: null,
      recorded_time_entry: null,
      warning: `The time entry was created, but Recorded Time verification failed: ${err.message}`,
    };
  }
}

export function registerActivityTools(server: McpServer): void {
  server.registerTool(
    "list_time_entries",
    {
      description: "List time entries (billable hours) from Clio",
      inputSchema: {
        matter_id: z.number().int().positive().optional().describe("Filter by matter ID"),
        task_id: z.number().int().positive().optional().describe("Filter by the associated task ID"),
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("ISO date (YYYY-MM-DD) — entries on or after this date"),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("ISO date (YYYY-MM-DD) — entries on or before this date"),
        limit: z.number().int().min(1).max(200).default(25).describe("Max results to return (1-200)"),
        page_token: z.string().optional().describe("Cursor from a previous list_time_entries response to fetch the next page"),
      },
    },
    async ({ matter_id, task_id, start_date, end_date, limit, page_token }) => {
      try {
        const params: Record<string, string> = {
          fields: ACTIVITY_FIELDS,
          limit: String(limit),
          type: "TimeEntry",
        };
        if (matter_id) params["matter_id"] = String(matter_id);
        if (task_id) params["task_id"] = String(task_id);
        if (start_date) params["start_date"] = start_date;
        if (end_date) params["end_date"] = end_date;
        if (page_token) params["page_token"] = page_token;

        const data = await clioGet("/activities.json", params);
        const entries = data.data as any[];
        const nextPageToken = entries.length >= limit ? extractNextPageToken(data.meta) : null;

        await appendAuditLog({
          tool: "list_time_entries",
          args: { matter_id, task_id, start_date, end_date, limit, page_token },
          outcome: "success",
          result_count: entries?.length ?? 0,
          ...(matter_id && { matter_id }),
        });

        const result = {
          time_entries: entries.map((e) => ({
            id: e.id,
            date: e.date,
            quantity_in_hours: e.quantity_in_hours,
            rate: e.price ?? null,
            total: e.total,
            description: e.note ?? null,
            matter: e.matter ? { id: e.matter.id, display_number: e.matter.display_number } : null,
            task: e.task ? { id: e.task.id } : null,
            user: e.user ? { id: e.user.id, name: e.user.name } : null,
          })),
          total_count: data.meta?.records ?? entries.length,
          has_more: nextPageToken !== null,
          next_page_token: nextPageToken,
        };

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        await appendAuditLog({
          tool: "list_time_entries",
          args: { matter_id, task_id, start_date, end_date, limit, page_token },
          outcome: "error",
          error_message: err.message,
          ...(matter_id && { matter_id }),
        });
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "log_time_entry",
    {
      description: "Create a new billable (or non-billable) time entry on a Clio matter, optionally associate it with a task, and verify the task's Recorded Time by reading it back. Use for time entries only; for expenses, hard costs, or soft costs use create_activity.",
      inputSchema: {
        matter_id: z.number().int().positive().describe("Matter ID to log time against"),
        task_id: z.number().int().positive().optional().describe("Task ID to associate the time entry with; the tool reads the task back and verifies Recorded Time"),
        date: z.string().date().describe("ISO date (YYYY-MM-DD) when work was performed"),
        quantity_in_hours: z.number().positive().describe("Hours worked (e.g. 1.5 for 90 minutes)"),
        note: z.string().optional().describe("Description of work performed"),
        price: z.number().optional().describe("Hourly rate override; omit to use Clio rate hierarchy"),
        non_billable: z.boolean().optional().describe("Mark entry as non-billable (default: billable)"),
        no_charge: z.boolean().optional().describe("Show non-billable entry on bill anyway"),
        activity_description_id: z.number().int().positive().optional().describe("Clio activity description / billing code ID"),
        user_id: z.number().int().positive().optional().describe("User to log time for; defaults to authenticated user"),
      },
    },
    async ({ matter_id, task_id, date, quantity_in_hours, note, price, non_billable, no_charge, activity_description_id, user_id }) => {
      try {
        const activityData: Record<string, unknown> = {
          type: "TimeEntry",
          date,
          quantity: quantity_in_hours * 3600,
          matter: { id: matter_id },
        };
        if (task_id !== undefined)                 activityData["task"] = { id: task_id };
        if (note !== undefined)                  activityData["note"] = note;
        if (price !== undefined)                 activityData["price"] = price;
        if (non_billable !== undefined)           activityData["non_billable"] = non_billable;
        if (no_charge !== undefined)              activityData["no_charge"] = no_charge;
        if (activity_description_id !== undefined) activityData["activity_description"] = { id: activity_description_id };
        if (user_id !== undefined)               activityData["user"] = { id: user_id };

        const data = await clioPost(`/activities.json?fields=${encodeURIComponent(ACTIVITY_FIELDS)}`, { data: activityData });
        const entry = data.data;
        const recordedTimeVerification = task_id !== undefined
          ? await verifyTaskRecordedTime(task_id, entry.id)
          : null;

        await appendAuditLog({
          tool: "log_time_entry",
          args: { matter_id, task_id, date, quantity_in_hours, note, price, non_billable, no_charge, activity_description_id, user_id },
          outcome: "success",
          matter_id,
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              time_entry: {
                id: entry.id,
                date: entry.date,
                quantity_in_hours: entry.quantity_in_hours,
                rate: entry.price ?? null,
                total: entry.total,
                note: entry.note ?? null,
                non_billable: entry.non_billable ?? false,
                matter: entry.matter ? { id: entry.matter.id, display_number: entry.matter.display_number } : null,
                task: entry.task ? { id: entry.task.id } : null,
                user: entry.user ? { id: entry.user.id, name: entry.user.name } : null,
              },
              recorded_time_verification: recordedTimeVerification,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        await appendAuditLog({
          tool: "log_time_entry",
          args: { matter_id, task_id, date, quantity_in_hours, note, price, non_billable, no_charge, activity_description_id, user_id },
          outcome: "error",
          error_message: err.message,
          matter_id,
        });
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "create_activity",
    {
      description: "Create a Clio activity — TimeEntry, ExpenseEntry, HardCostEntry, or SoftCostEntry. For time entries on a matter, prefer log_time_entry.",
      inputSchema: {
        type: z.enum(["TimeEntry", "ExpenseEntry", "HardCostEntry", "SoftCostEntry"]).describe("Activity type"),
        date: z.string().date().describe("ISO date (YYYY-MM-DD) when the activity occurred"),
        matter_id: z.number().int().positive().optional().describe("Matter ID to associate with"),
        task_id: z.number().int().positive().optional().describe("Task ID to associate with a TimeEntry; Recorded Time is read back and verified"),
        note: z.string().optional().describe("Description / details"),
        quantity_in_hours: z.number().positive().optional().describe("Hours (TimeEntry only); converted to seconds internally"),
        price: z.number().optional().describe("Hourly rate (TimeEntry) or expense amount (Expense types)"),
        non_billable: z.boolean().optional().describe("Non-billable flag (TimeEntry only)"),
        no_charge: z.boolean().optional().describe("Show non-billable on bill"),
        activity_description_id: z.number().int().positive().optional().describe("Activity description / billing code ID"),
        user_id: z.number().int().positive().optional().describe("User to associate; defaults to authenticated user"),
        reference: z.string().optional().describe("Check reference (HardCostEntry only)"),
        tax_setting: z.enum(["no_tax", "tax_1_only", "tax_2_only", "tax_1_and_tax_2"]).optional().describe("Tax setting (expense entries)"),
      },
    },
    async ({ type, date, matter_id, task_id, note, quantity_in_hours, price, non_billable, no_charge, activity_description_id, user_id, reference, tax_setting }) => {
      if (type === "TimeEntry" && quantity_in_hours === undefined) {
        await appendAuditLog({
          tool: "create_activity",
          args: { type, date, matter_id, task_id, note, quantity_in_hours, price, non_billable, no_charge, activity_description_id, user_id },
          outcome: "error",
          error_message: "quantity_in_hours is required for TimeEntry",
          ...(matter_id !== undefined && { matter_id }),
        });
        return { content: [{ type: "text", text: "Error: quantity_in_hours is required for TimeEntry" }], isError: true };
      }
      if (task_id !== undefined && type !== "TimeEntry") {
        await appendAuditLog({
          tool: "create_activity",
          args: { type, date, matter_id, task_id, note, quantity_in_hours, price, non_billable, no_charge, activity_description_id, user_id },
          outcome: "error",
          error_message: "task_id is only valid for TimeEntry",
          ...(matter_id !== undefined && { matter_id }),
        });
        return { content: [{ type: "text", text: "Error: task_id is only valid for TimeEntry" }], isError: true };
      }

      try {
        const activityData: Record<string, unknown> = { type, date };
        if (matter_id !== undefined)               activityData["matter"] = { id: matter_id };
        if (task_id !== undefined)                 activityData["task"] = { id: task_id };
        if (note !== undefined)                    activityData["note"] = note;
        if (quantity_in_hours !== undefined)       activityData["quantity"] = quantity_in_hours * 3600;
        if (price !== undefined)                   activityData["price"] = price;
        if (non_billable !== undefined)            activityData["non_billable"] = non_billable;
        if (no_charge !== undefined)               activityData["no_charge"] = no_charge;
        if (activity_description_id !== undefined) activityData["activity_description"] = { id: activity_description_id };
        if (user_id !== undefined)                 activityData["user"] = { id: user_id };
        if (reference !== undefined)               activityData["reference"] = reference;
        if (tax_setting !== undefined)             activityData["tax_setting"] = tax_setting;

        const data = await clioPost(`/activities.json?fields=${encodeURIComponent(ACTIVITY_FIELDS)}`, { data: activityData });
        const entry = data.data;
        const recordedTimeVerification = task_id !== undefined
          ? await verifyTaskRecordedTime(task_id, entry.id)
          : null;

        await appendAuditLog({
          tool: "create_activity",
          args: { type, date, matter_id, task_id, note, quantity_in_hours, price, non_billable, no_charge, activity_description_id, user_id },
          outcome: "success",
          ...(matter_id !== undefined && { matter_id }),
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              activity: {
                id: entry.id,
                type: entry.type,
                date: entry.date,
                quantity_in_hours: entry.quantity_in_hours ?? null,
                price: entry.price ?? null,
                total: entry.total ?? null,
                note: entry.note ?? null,
                non_billable: entry.non_billable ?? false,
                matter: entry.matter ? { id: entry.matter.id, display_number: entry.matter.display_number } : null,
                task: entry.task ? { id: entry.task.id } : null,
                user: entry.user ? { id: entry.user.id, name: entry.user.name } : null,
              },
              recorded_time_verification: recordedTimeVerification,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        await appendAuditLog({
          tool: "create_activity",
          args: { type, date, matter_id, task_id, note, quantity_in_hours, price, non_billable, no_charge, activity_description_id, user_id },
          outcome: "error",
          error_message: err.message,
          ...(matter_id !== undefined && { matter_id }),
        });
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );
}
