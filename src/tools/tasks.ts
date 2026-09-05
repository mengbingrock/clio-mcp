import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import z from "zod";
import { clioGet, clioPost, clioPatch, ClioApiError, extractNextPageToken } from "../utils/clioClient.js";
import { appendAuditLog } from "../utils/auditLog.js";

const TASK_LIST_FIELDS =
  "id,name,priority,due_at,status,permission,time_estimated,notify_completion,assignee{id,name},matter{id,display_number},reminders{id,notification_method}";
const TASK_DETAIL_FIELDS =
  "id,etag,name,status,description,description_text_type,priority,due_at,permission,completed_at,notify_completion,statute_of_limitations,time_estimated,created_at,updated_at,time_entries_count,task_type{id,name},assigner{id,name},matter{id,display_number},assignee{id,type,name},reminders{id,duration,next_delivery_at,state,created_at,updated_at,notification_method}";

const dueAtSchema = z.string().datetime({ offset: true }).describe(
  "ISO-8601 due timestamp with an explicit UTC offset, e.g. 2026-09-05T17:00:00-07:00 for 5:00 PM Pacific Daylight Time"
);

const STATUS_MAP: Record<string, string> = { Pending: "pending", Complete: "complete", "In Progress": "in_progress", "In Review": "in_review", "Draft": "draft" };

export function registerTaskTools(server: McpServer): void {
  server.registerTool(
    "list_tasks",
    {
      description: "List tasks from Clio with optional filters",
      inputSchema: {
        matter_id: z.number().int().positive().optional().describe("Filter tasks by matter ID"),
        status: z.enum(["Pending", "Complete", "In Progress", "In Review", "Draft"]).optional().describe("Filter by task status"),
        due_date_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("ISO date (YYYY-MM-DD) — tasks due on or after this date"),
        due_date_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("ISO date (YYYY-MM-DD) — tasks due on or before this date"),
        limit: z.number().int().min(1).max(200).default(25).describe("Max results to return (1-200)"),
        page_token: z.string().optional().describe("Cursor from a previous list_tasks response to fetch the next page"),
      },
    },
    async ({ matter_id, status, due_date_start, due_date_end, limit, page_token }) => {
      try {
        const params: Record<string, string> = { fields: TASK_LIST_FIELDS, limit: String(limit) };
        if (matter_id) params["matter_id"] = String(matter_id);
        if (status) params["status"] = STATUS_MAP[status];
        if (due_date_start) params["due_at_from"] = due_date_start;
        if (due_date_end) params["due_at_to"] = due_date_end;
        if (page_token) params["page_token"] = page_token;

        const data = await clioGet("/tasks.json", params);
        const tasks = data.data as any[];
        const nextPageToken = tasks.length >= limit ? extractNextPageToken(data.meta) : null;

        await appendAuditLog({
          tool: "list_tasks",
          args: { matter_id, status, due_date_start, due_date_end, limit, page_token },
          outcome: "success",
          result_count: tasks?.length ?? 0,
          ...(matter_id && { matter_id }),
        });

        const result = {
          tasks: tasks.map((t) => ({
            id: t.id,
            name: t.name,
            priority: t.priority,
            due_at: t.due_at ?? null,
            due_date: t.due_at ? t.due_at.substring(0, 10) : null,
            status: t.status,
            permission: t.permission ?? null,
            time_estimated: t.time_estimated ?? null,
            notify_completion: t.notify_completion ?? null,
            assignee: t.assignee ? { id: t.assignee.id, name: t.assignee.name } : null,
            matter: t.matter ? { id: t.matter.id, display_number: t.matter.display_number } : null,
            reminder: t.reminders?.length > 0
              ? { notification_method: t.reminders[0].notification_method }
              : null,
          })),
          total_count: data.meta?.records ?? tasks.length,
          has_more: nextPageToken !== null,
          next_page_token: nextPageToken,
        };

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        await appendAuditLog({
          tool: "list_tasks",
          args: { matter_id, status, due_date_start, due_date_end, limit, page_token },
          outcome: "error",
          error_message: err.message,
          ...(matter_id && { matter_id }),
        });
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "get_task",
    {
      description: "Get the complete details for a single Clio task, including its description, due_at value, estimate, notifications, and visibility",
      inputSchema: {
        task_id: z.number().int().positive().describe("The Clio task ID"),
      },
    },
    async ({ task_id }) => {
      try {
        const data = await clioGet(`/tasks/${task_id}.json`, { fields: TASK_DETAIL_FIELDS });
        const task = data.data;
        const result = {
          id: task.id,
          etag: task.etag ?? null,
          name: task.name,
          status: task.status,
          description: task.description ?? null,
          description_text_type: task.description_text_type ?? null,
          priority: task.priority,
          due_at: task.due_at ?? null,
          permission: task.permission ?? null,
          completed_at: task.completed_at ?? null,
          notify_completion: task.notify_completion ?? null,
          statute_of_limitations: task.statute_of_limitations ?? null,
          time_estimated: task.time_estimated ?? null,
          time_estimated_unit: "minutes",
          time_entries_count: task.time_entries_count ?? 0,
          task_type: task.task_type
            ? { id: task.task_type.id, name: task.task_type.name }
            : null,
          assigner: task.assigner ? { id: task.assigner.id, name: task.assigner.name } : null,
          assignee: task.assignee
            ? { id: task.assignee.id, type: task.assignee.type ?? null, name: task.assignee.name }
            : null,
          matter: task.matter
            ? { id: task.matter.id, display_number: task.matter.display_number }
            : null,
          reminders: (task.reminders ?? []).map((reminder: any) => ({
            id: reminder.id,
            duration: reminder.duration ?? null,
            next_delivery_at: reminder.next_delivery_at ?? null,
            state: reminder.state ?? null,
            notification_method: reminder.notification_method ?? null,
            created_at: reminder.created_at ?? null,
            updated_at: reminder.updated_at ?? null,
          })),
          created_at: task.created_at ?? null,
          updated_at: task.updated_at ?? null,
        };

        await appendAuditLog({ tool: "get_task", args: { task_id }, outcome: "success", ...(task.matter?.id && { matter_id: task.matter.id }) });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        if (err instanceof ClioApiError && err.statusCode === 404) {
          await appendAuditLog({ tool: "get_task", args: { task_id }, outcome: "success" });
          return { content: [{ type: "text", text: `Task ${task_id} not found.` }] };
        }
        await appendAuditLog({ tool: "get_task", args: { task_id }, outcome: "error", error_message: err.message });
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "create_task",
    {
      description: "Create a task on a matter in Clio",
      inputSchema: {
        matter_id: z.number().int().positive().describe("Matter ID to associate the task with"),
        name: z.string().min(1).describe("Task name / description"),
        description: z.string().min(2).describe("Detailed description of the task"),
        priority: z.enum(["High", "Normal", "Low"]).default("Normal").describe("Task priority"),
        due_at: dueAtSchema.optional(),
        due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Legacy date-only deadline (YYYY-MM-DD); prefer due_at when a time matters"),
        assignee_id: z.number().int().positive().optional().describe("Clio user ID to assign the task to"),
        time_estimated: z.number().int().min(0).optional().describe("Estimated completion time in minutes; use 120 for 2 hours"),
        notify_assignee: z.boolean().optional().describe("Notify the assignee that this task was assigned"),
        notify_completion: z.boolean().optional().describe("Notify the assigner when this task is completed"),
        permission: z.enum(["private", "public"]).optional().describe("Task visibility; private is limited to the creator, assignee, and administrators"),
      },
    },
    async ({ matter_id, name, description, priority, due_at, due_date, assignee_id, time_estimated, notify_assignee, notify_completion, permission }) => {
      if (due_at !== undefined && due_date !== undefined) {
        return { content: [{ type: "text", text: "Error: provide only one of due_at or due_date, not both" }], isError: true };
      }
      try {
        const taskData: Record<string, unknown> = {
          name,
          description,
          priority,
          matter: { id: matter_id },
        };
        if (due_at !== undefined) taskData["due_at"] = due_at;
        else if (due_date !== undefined) taskData["due_at"] = due_date;
        if (assignee_id) taskData["assignee"] = { id: assignee_id, type: "User" };
        if (time_estimated !== undefined) taskData["time_estimated"] = time_estimated;
        if (notify_assignee !== undefined) taskData["notify_assignee"] = notify_assignee;
        if (notify_completion !== undefined) taskData["notify_completion"] = notify_completion;
        if (permission !== undefined) taskData["permission"] = permission;

        const data = await clioPost("/tasks.json", { data: taskData });
        const task = data.data;

        await appendAuditLog({
          tool: "create_task",
          args: { matter_id, priority, due_at, due_date, assignee_id, time_estimated, notify_assignee, notify_completion, permission },
          outcome: "success",
          matter_id,
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              task: {
                id: task.id,
                name: task.name,
                priority: task.priority,
                due_at: task.due_at ?? taskData.due_at ?? null,
                time_estimated: task.time_estimated ?? time_estimated ?? null,
                notify_completion: task.notify_completion ?? notify_completion ?? null,
                permission: task.permission ?? permission ?? "public",
                matter_id,
              },
            }, null, 2),
          }],
        };
      } catch (err: any) {
        await appendAuditLog({
          tool: "create_task",
          args: { matter_id, priority, due_at, due_date, assignee_id, time_estimated, notify_assignee, notify_completion, permission },
          outcome: "error",
          error_message: err.message,
          matter_id,
        });
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "update_task",
    {
      description: "Update one or more fields on an existing Clio task",
      inputSchema: {
        task_id: z.number().int().positive().describe("ID of the task to update"),
        name: z.string().min(1).optional().describe("New task name"),
        description: z.string().optional().describe("New task description"),
        priority: z.enum(["High", "Normal", "Low"]).optional().describe("New priority"),
        due_at: dueAtSchema.optional(),
        due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Legacy date-only deadline (YYYY-MM-DD); prefer due_at when a time matters"),
        status: z.enum(["Pending", "Complete", "In Progress", "In Review", "Draft"]).optional().describe("New task status"),
        assignee_id: z.number().int().positive().optional().describe("Clio user ID to reassign the task to"),
        time_estimated: z.number().int().min(0).optional().describe("Estimated completion time in minutes; use 120 for 2 hours"),
        notify_assignee: z.boolean().optional().describe("Notify the assignee about this task update"),
        notify_completion: z.boolean().optional().describe("Notify the assigner when this task is completed"),
        permission: z.enum(["private", "public"]).optional().describe("Task visibility"),
      },
    },
    async ({ task_id, name, description, priority, due_at, due_date, status, assignee_id, time_estimated, notify_assignee, notify_completion, permission }) => {
      if (due_at !== undefined && due_date !== undefined) {
        return { content: [{ type: "text", text: "Error: provide only one of due_at or due_date, not both" }], isError: true };
      }
      if ([name, description, priority, due_at, due_date, status, assignee_id, time_estimated, notify_assignee, notify_completion, permission].every((v) => v === undefined)) {
        return { content: [{ type: "text", text: "Error: at least one field to update must be provided" }], isError: true };
      }
      try {
        const taskData: Record<string, unknown> = {};
        if (name !== undefined) taskData["name"] = name;
        if (description !== undefined) taskData["description"] = description;
        if (priority !== undefined) taskData["priority"] = priority;
        if (due_at !== undefined) taskData["due_at"] = due_at;
        else if (due_date !== undefined) taskData["due_at"] = due_date;
        if (status !== undefined) taskData["status"] = STATUS_MAP[status];
        if (assignee_id !== undefined) taskData["assignee"] = { id: assignee_id, type: "User" };
        if (time_estimated !== undefined) taskData["time_estimated"] = time_estimated;
        if (notify_assignee !== undefined) taskData["notify_assignee"] = notify_assignee;
        if (notify_completion !== undefined) taskData["notify_completion"] = notify_completion;
        if (permission !== undefined) taskData["permission"] = permission;

        const data = await clioPatch(`/tasks/${task_id}.json`, { data: taskData });
        const task = data.data;

        await appendAuditLog({
          tool: "update_task",
          args: { task_id, name_changed: name !== undefined, description_changed: description !== undefined, priority, due_at, due_date, status, assignee_id, time_estimated, notify_assignee, notify_completion, permission },
          outcome: "success",
          ...(task.matter?.id && { matter_id: task.matter.id }),
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              task: {
                id: task.id,
                name: task.name,
                priority: task.priority,
                status: task.status,
                due_at: task.due_at ?? taskData.due_at ?? null,
                time_estimated: task.time_estimated ?? time_estimated ?? null,
                notify_completion: task.notify_completion ?? notify_completion ?? null,
                permission: task.permission ?? permission ?? null,
                matter_id: task.matter?.id ?? null,
              },
            }, null, 2),
          }],
        };
      } catch (err: any) {
        await appendAuditLog({
          tool: "update_task",
          args: { task_id, name_changed: name !== undefined, description_changed: description !== undefined, priority, due_at, due_date, status, assignee_id, time_estimated, notify_assignee, notify_completion, permission },
          outcome: "error",
          error_message: err.message,
        });
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "complete_task",
    {
      description: "Mark a Clio task as complete",
      inputSchema: {
        task_id: z.number().int().positive().describe("ID of the task to mark complete"),
      },
    },
    async ({ task_id }) => {
      try {
        const data = await clioPatch(`/tasks/${task_id}.json`, { data: { status: STATUS_MAP["Complete"] } });
        const task = data.data;

        await appendAuditLog({
          tool: "complete_task",
          args: { task_id },
          outcome: "success",
          ...(task.matter?.id && { matter_id: task.matter.id }),
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              task: {
                id: task.id,
                name: task.name,
                status: task.status,
                completed_at: task.completed_at ?? null,
              },
            }, null, 2),
          }],
        };
      } catch (err: any) {
        await appendAuditLog({
          tool: "complete_task",
          args: { task_id },
          outcome: "error",
          error_message: err.message,
        });
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );
}
