import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import z from "zod";
import { clioGet, clioPost, clioPatch, clioDelete, extractNextPageToken } from "../utils/clioClient.js";
import { appendAuditLog } from "../utils/auditLog.js";

const id = z.number().int().positive();
const units = z.enum(["weeks", "days", "hours", "minutes"]);
const states = z.enum(["initializing", "scheduling", "rescheduling", "scheduled", "attempting_delivery", "delivery_failed", "delivered", "delivery_skipped", "invalid_user"]);
export const REMINDER_FIELDS = "id,etag,duration,next_delivery_at,state,created_at,updated_at,notification_method{id,type,email_address,is_default_email_address},subject{id,type}";
const USER_FIELDS = "id,name,email,enabled,notification_methods{id,etag,type,email_address,is_default_email_address}";
const output = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

async function methods(userId?: number) {
  const user = (await clioGet(userId === undefined ? "/users/who_am_i.json" : `/users/${userId}.json`, { fields: USER_FIELDS })).data;
  if (!user?.id || user.enabled === false) throw new Error("Notification recipient is unavailable or disabled");
  return { user: { id: user.id, name: user.name, email: user.email, enabled: user.enabled }, notification_methods: user.notification_methods ?? [] };
}
async function verifyMethod(userId: number, methodId: number) {
  const found = await methods(userId);
  const method = found.notification_methods.find((m: any) => m.id === methodId);
  if (!method) throw new Error("Notification method does not belong to the specified recipient");
  if (method.type === "Popup") {
    if ((await methods()).user.id !== userId) throw new Error("Popup reminders can only target the signed-in user");
  } else if (method.type !== "Email" || !method.email_address) {
    throw new Error("Only verified Email methods or the signed-in user's Popup method are supported");
  }
}
export function registerReminderTools(server: McpServer): void {
  const add = (name: string, description: string, inputSchema: z.ZodRawShape, handler: (args: any) => Promise<unknown>) => {
    server.registerTool(name, { description, inputSchema }, async (args) => {
      try {
        const result = await handler(args);
        await appendAuditLog({ tool: name, args, outcome: "success" });
        return output(result);
      } catch (err: any) {
        await appendAuditLog({ tool: name, args, outcome: "error", error_message: err.message });
        return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
      }
    });
  };
  add("list_notification_methods", "Read an enabled Clio user's existing notification methods and their recipients. Does not create methods or send email.", { user_id: id.optional() }, args => methods(args.user_id));
  add("list_reminders", "List actual Clio reminders and delivery schedules. Subject filters distinguish calendar entries from tasks; scheduled is not proof of delivered email.", {
    subject_id: id.optional(), subject_type: z.enum(["calendar_entry", "task"]).optional(), user_id: id.optional(), notification_method_id: id.optional(),
    state: states.optional(), limit: z.number().int().min(1).max(200).default(25), page_token: z.string().optional(),
  }, async args => {
    if (args.subject_id !== undefined && args.subject_type === undefined) throw new Error("subject_type is required with subject_id");
    const params: Record<string, string> = { fields: REMINDER_FIELDS, limit: String(args.limit ?? 25) };
    for (const key of ["subject_id", "subject_type", "user_id", "notification_method_id", "state", "page_token"]) if (args[key] !== undefined) params[key] = String(args[key]);
    const response = await clioGet("/reminders.json", params), next = extractNextPageToken(response.meta);
    return { reminders: response.data, has_more: next !== null, next_page_token: next };
  });
  add("get_reminder", "Read one reminder, including next_delivery_at, state, subject, method, and ETag. Recheck after extensions; Clio may reschedule asynchronously.", { reminder_id: id }, async args =>
    (await clioGet(`/reminders/${args.reminder_id}.json`, { fields: REMINDER_FIELDS })).data);
  add("create_reminder", "Create an actual Clio Email or self-Popup reminder. Offsets are elapsed units, not business days. Delivery must be verified separately.", {
    subject_id: id, subject_type: z.enum(["CalendarEntry", "Task"]), user_id: id, notification_method_id: id,
    duration_unit: units, duration_value: z.number().int().min(0).max(2147483647),
  }, async args => {
    await verifyMethod(args.user_id, args.notification_method_id);
    const subjectPath = args.subject_type === "CalendarEntry" ? "calendar_entries" : "tasks";
    const subject = (await clioGet(`/${subjectPath}/${args.subject_id}.json`, { fields: "id" })).data;
    if (subject?.id !== args.subject_id) throw new Error("Reminder subject could not be verified");
    return (await clioPost("/reminders.json", { data: {
      subject: { id: args.subject_id, type: args.subject_type }, notification_method: { id: args.notification_method_id },
      duration_unit: args.duration_unit, duration_value: args.duration_value,
    } }, { fields: REMINDER_FIELDS })).data;
  });
  add("update_reminder", "Update an existing reminder with ETag protection. Does not move its subject. Read next_delivery_at again until Clio finishes rescheduling.", {
    reminder_id: id, expected_etag: z.string().min(1).optional(), duration_unit: units.optional(), duration_value: z.number().int().min(0).max(2147483647).optional(),
    notification_method_id: id.optional(), user_id: id.optional(),
  }, async args => {
    if ((args.duration_unit === undefined) !== (args.duration_value === undefined)) throw new Error("Provide duration_unit and duration_value together");
    if (args.duration_unit === undefined && args.notification_method_id === undefined) throw new Error("No reminder changes supplied");
    if (args.notification_method_id !== undefined) {
      if (args.user_id === undefined) throw new Error("user_id is required to verify a replacement notification method");
      await verifyMethod(args.user_id, args.notification_method_id);
    }
    const current = (await clioGet(`/reminders/${args.reminder_id}.json`, { fields: REMINDER_FIELDS })).data;
    if (!current?.etag) throw new Error("Cannot update safely without a current reminder ETag");
    if (args.expected_etag !== undefined && args.expected_etag !== current.etag) throw new Error("Reminder changed since review; reconcile before updating");
    const data: Record<string, unknown> = {};
    if (args.duration_unit !== undefined) { data.duration_unit = args.duration_unit; data.duration_value = args.duration_value; }
    if (args.notification_method_id !== undefined) data.notification_method = { id: args.notification_method_id };
    return (await clioPatch(`/reminders/${args.reminder_id}.json`, { data }, { fields: REMINDER_FIELDS }, { ifMatch: current.etag })).data;
  });
  add("delete_reminder", "Delete one explicitly authorized reminder by ID. Does not delete its calendar entry or task.", { reminder_id: id }, async args => {
    await clioDelete(`/reminders/${args.reminder_id}.json`); return { success: true, deleted_reminder_id: args.reminder_id };
  });
}
