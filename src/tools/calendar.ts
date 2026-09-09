import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import z from "zod";
import { clioDelete, clioGet, clioPatch, clioPost, ClioApiError, extractNextPageToken } from "../utils/clioClient.js";
import { appendAuditLog } from "../utils/auditLog.js";

const CALENDAR_LIST_FIELDS =
  "id,summary,description,location,start_at,end_at,all_day,calendar_owner_id,start_at_time_zone,matter{id,display_number},calendar_owner{id,name,type,color},attendees{id,type,name}";
const CALENDAR_DETAIL_FIELDS =
  "id,etag,summary,description,location,start_at,start_date,start_time,end_at,end_date,end_time,all_day,recurrence_rule,parent_calendar_entry_id,court_rule,created_at,updated_at,permission,calendar_owner_id,start_at_time_zone,time_entries_count,conference_meeting{id,type,join_url},matter{id,display_number},calendar_owner{id,name,type,color},calendar_entry_event_type{id,name,color},attendees{id,type,name,email,enabled},calendars{id,name,type,color},reminders{id,duration,next_delivery_at,state,notification_method}";

const calendarDateTimeSchema = z.string().datetime({ offset: true }).describe(
  "ISO-8601 timestamp with an explicit time-zone offset or Z, e.g. 2026-09-05T17:00:00-07:00"
);

export function toUtcIso(input: string): string {
  const parsed = calendarDateTimeSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error("calendar datetime must be a valid ISO-8601 timestamp with an explicit time-zone offset or Z");
  }
  return new Date(parsed.data).toISOString();
}

function mapCalendarEntry(entry: any): Record<string, unknown> {
  return {
    id: entry.id,
    etag: entry.etag ?? null,
    summary: entry.summary,
    description: entry.description ?? null,
    location: entry.location ?? null,
    start_at: entry.start_at,
    start_date: entry.start_date ?? null,
    start_time: entry.start_time ?? null,
    end_at: entry.end_at,
    end_date: entry.end_date ?? null,
    end_time: entry.end_time ?? null,
    start_at_time_zone: entry.start_at_time_zone ?? null,
    all_day: entry.all_day ?? false,
    recurrence_rule: entry.recurrence_rule ?? null,
    parent_calendar_entry_id: entry.parent_calendar_entry_id ?? null,
    court_rule: entry.court_rule ?? false,
    permission: entry.permission ?? null,
    calendar_owner_id: entry.calendar_owner_id ?? entry.calendar_owner?.id ?? null,
    calendar_owner: entry.calendar_owner
      ? { id: entry.calendar_owner.id, name: entry.calendar_owner.name, type: entry.calendar_owner.type, color: entry.calendar_owner.color }
      : null,
    matter: entry.matter ? { id: entry.matter.id, display_number: entry.matter.display_number } : null,
    event_type: entry.calendar_entry_event_type
      ? { id: entry.calendar_entry_event_type.id, name: entry.calendar_entry_event_type.name, color: entry.calendar_entry_event_type.color }
      : null,
    attendees: (entry.attendees ?? []).map((attendee: any) => ({
      id: attendee.id,
      type: attendee.type ?? null,
      name: attendee.name,
      email: attendee.email ?? null,
      enabled: attendee.enabled ?? null,
    })),
    calendars: (entry.calendars ?? []).map((calendar: any) => ({
      id: calendar.id,
      name: calendar.name,
      type: calendar.type,
      color: calendar.color,
    })),
    reminders: (entry.reminders ?? []).map((reminder: any) => ({
      id: reminder.id,
      duration: reminder.duration ?? null,
      next_delivery_at: reminder.next_delivery_at ?? null,
      state: reminder.state ?? null,
      notification_method: reminder.notification_method ?? null,
    })),
    conference_meeting: entry.conference_meeting
      ? { id: entry.conference_meeting.id, type: entry.conference_meeting.type, join_url: entry.conference_meeting.join_url }
      : null,
    time_entries_count: entry.time_entries_count ?? 0,
    created_at: entry.created_at ?? null,
    updated_at: entry.updated_at ?? null,
  };
}

export function registerCalendarTools(server: McpServer): void {
  server.registerTool(
    "list_calendar_entries",
    {
      description: "List calendar entries in Clio for an explicit time range, optionally filtered by calendar or matter",
      inputSchema: {
        from: calendarDateTimeSchema.describe("Inclusive range start; include an explicit offset or Z"),
        to: calendarDateTimeSchema.describe("Inclusive range end; include an explicit offset or Z"),
        calendar_id: z.number().int().positive().optional().describe("Only entries belonging to this calendar"),
        matter_id: z.number().int().positive().optional().describe("Only entries associated with this matter"),
        limit: z.number().int().min(1).max(200).default(25).describe("Max results to return (1-200)"),
        page_token: z.string().optional().describe("Cursor from a previous list_calendar_entries response to fetch the next page"),
      },
    },
    async ({ from, to, calendar_id, matter_id, limit, page_token }) => {
      try {
        const params: Record<string, string> = {
          from: toUtcIso(from),
          to: toUtcIso(to),
          fields: CALENDAR_LIST_FIELDS,
          limit: String(limit),
        };
        if (calendar_id !== undefined) params["calendar_id"] = String(calendar_id);
        if (matter_id !== undefined) params["matter_id"] = String(matter_id);
        if (page_token) params["page_token"] = page_token;

        const data = await clioGet("/calendar_entries.json", params);
        const entries = data.data as any[];
        const nextPageToken = entries.length >= limit ? extractNextPageToken(data.meta) : null;

        await appendAuditLog({
          tool: "list_calendar_entries",
          args: { from, to, calendar_id, matter_id, limit, page_token },
          outcome: "success",
          result_count: entries?.length ?? 0,
          ...(matter_id && { matter_id }),
        });

        const result = {
          entries: entries.map(mapCalendarEntry),
          total_count: data.meta?.records ?? entries.length,
          has_more: nextPageToken !== null,
          next_page_token: nextPageToken,
        };

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        await appendAuditLog({ tool: "list_calendar_entries", args: { from, to, calendar_id, matter_id, limit, page_token }, outcome: "error", error_message: err.message, ...(matter_id && { matter_id }) });
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "get_calendar_entry",
    {
      description: "Get complete details for a single Clio calendar entry",
      inputSchema: {
        calendar_entry_id: z.number().int().positive().describe("The Clio calendar entry ID"),
      },
    },
    async ({ calendar_entry_id }) => {
      try {
        const data = await clioGet(`/calendar_entries/${calendar_entry_id}.json`, { fields: CALENDAR_DETAIL_FIELDS });
        const entry = data.data;
        await appendAuditLog({ tool: "get_calendar_entry", args: { calendar_entry_id }, outcome: "success", ...(entry.matter?.id && { matter_id: entry.matter.id }) });
        return { content: [{ type: "text", text: JSON.stringify(mapCalendarEntry(entry), null, 2) }] };
      } catch (err: any) {
        if (err instanceof ClioApiError && err.statusCode === 404) {
          await appendAuditLog({ tool: "get_calendar_entry", args: { calendar_entry_id }, outcome: "success" });
          return { content: [{ type: "text", text: `Calendar entry ${calendar_entry_id} not found.` }] };
        }
        await appendAuditLog({ tool: "get_calendar_entry", args: { calendar_entry_id }, outcome: "error", error_message: err.message });
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "list_calendars",
    {
      description: "List calendars available in Clio — use the returned id as calendar_owner_id when creating entries",
      inputSchema: {
        limit: z.number().int().min(1).max(200).default(25).describe("Max results to return (1-200)"),
        page_token: z.string().optional().describe("Cursor from a previous list_calendars response to fetch the next page"),
      },
    },
    async ({ limit, page_token }) => {
      try {
        const params: Record<string, string> = { writeable: "true", fields: "id,name,type,color,permission,visible", limit: String(limit) };
        if (page_token) params["page_token"] = page_token;

        const data = await clioGet("/calendars.json", params);
        const calendars = data.data as any[];
        const nextPageToken = calendars.length >= limit ? extractNextPageToken(data.meta) : null;

        await appendAuditLog({
          tool: "list_calendars",
          args: { limit, page_token },
          outcome: "success",
          result_count: calendars?.length ?? 0,
        });

        const result = {
          calendars: calendars.map((c) => ({
            id: c.id,
            name: c.name,
            type: c.type ?? null,
            color: c.color ?? null,
            permission: c.permission ?? null,
            visible: c.visible ?? null,
          })),
          has_more: nextPageToken !== null,
          next_page_token: nextPageToken,
        };

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        await appendAuditLog({ tool: "list_calendars", args: { limit, page_token }, outcome: "error", error_message: err.message });
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "create_calendar_entry",
    {
      description: "Create a calendar entry (hearing, deadline, meeting) in Clio",
      inputSchema: {
        summary: z.string().min(1).describe("Short title of the event"),
        start_at: calendarDateTimeSchema.describe("Event start; include an explicit offset or Z"),
        end_at: calendarDateTimeSchema.describe("Event end; include an explicit offset or Z"),
        calendar_owner_id: z.number().int().positive().describe("Calendar ID to post this entry to — use list_calendars to find available IDs"),
        description: z.string().optional().describe("Detailed description of the event"),
        all_day: z.boolean().optional().describe("Whether the event spans the full day"),
        matter_id: z.number().int().positive().optional().describe("Matter ID to associate this entry with"),
        location: z.string().optional().describe("Geographic location of the event"),
        send_email_notification: z.boolean().optional().describe("Send email notifications to attendees"),
        attendee_ids: z.array(z.number().int().positive()).optional().describe("List of Clio user IDs to invite as attendees"),
      },
    },
    async ({ summary, start_at, end_at, calendar_owner_id, description, all_day, matter_id, location, send_email_notification, attendee_ids }) => {
      try {
        const body: Record<string, unknown> = {
          summary,
          start_at: toUtcIso(start_at),
          end_at: toUtcIso(end_at),
          calendar_owner: { id: calendar_owner_id },
        };
        if (description !== undefined)               body.description = description;
        if (all_day !== undefined)                   body.all_day = all_day;
        if (matter_id !== undefined)                 body.matter = { id: matter_id };
        if (location !== undefined)                  body.location = location;
        if (send_email_notification !== undefined)   body.send_email_notification = send_email_notification;
        if (attendee_ids?.length)                    body.attendees = attendee_ids.map((id) => ({ id }));

        const data = await clioPost("/calendar_entries.json", { data: body }, { fields: CALENDAR_DETAIL_FIELDS });
        const entry = data.data as any;

        await appendAuditLog({ tool: "create_calendar_entry", args: { summary, start_at, end_at, calendar_owner_id }, outcome: "success" });

        return { content: [{ type: "text", text: JSON.stringify(mapCalendarEntry(entry), null, 2) }] };
      } catch (err: any) {
        await appendAuditLog({ tool: "create_calendar_entry", args: { summary, start_at, end_at, calendar_owner_id }, outcome: "error", error_message: err.message });
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "update_calendar_entry",
    {
      description: "Update or reschedule an existing Clio calendar entry",
      inputSchema: {
        calendar_entry_id: z.number().int().positive().describe("ID of the calendar entry to update"),
        summary: z.string().min(1).optional().describe("New event title"),
        start_at: calendarDateTimeSchema.optional().describe("New event start with an explicit offset or Z"),
        end_at: calendarDateTimeSchema.optional().describe("New event end with an explicit offset or Z"),
        calendar_owner_id: z.number().int().positive().optional().describe("Move the entry to this writable calendar"),
        description: z.string().optional().describe("New event description"),
        all_day: z.boolean().optional().describe("Whether the event spans the full day"),
        matter_id: z.number().int().positive().optional().describe("Associate the entry with this matter"),
        location: z.string().optional().describe("New geographic location"),
        send_email_notification: z.boolean().optional().describe("Send email notifications to attendees about this update"),
        attendee_ids: z.array(z.number().int().positive()).optional().describe("Calendar or contact IDs to add as attendees"),
      },
    },
    async ({ calendar_entry_id, summary, start_at, end_at, calendar_owner_id, description, all_day, matter_id, location, send_email_notification, attendee_ids }) => {
      if ([summary, start_at, end_at, calendar_owner_id, description, all_day, matter_id, location, send_email_notification, attendee_ids].every((value) => value === undefined)) {
        return { content: [{ type: "text", text: "Error: at least one field to update must be provided" }], isError: true };
      }
      try {
        const body: Record<string, unknown> = {};
        if (summary !== undefined) body.summary = summary;
        if (start_at !== undefined) body.start_at = toUtcIso(start_at);
        if (end_at !== undefined) body.end_at = toUtcIso(end_at);
        if (calendar_owner_id !== undefined) body.calendar_owner = { id: calendar_owner_id };
        if (description !== undefined) body.description = description;
        if (all_day !== undefined) body.all_day = all_day;
        if (matter_id !== undefined) body.matter = { id: matter_id };
        if (location !== undefined) body.location = location;
        if (send_email_notification !== undefined) body.send_email_notification = send_email_notification;
        if (attendee_ids !== undefined) body.attendees = attendee_ids.map((id) => ({ id }));

        const updated = await clioPatch(
          `/calendar_entries/${calendar_entry_id}.json`,
          { data: body },
          { fields: CALENDAR_DETAIL_FIELDS }
        );
        const entry = updated.data;
        await appendAuditLog({
          tool: "update_calendar_entry",
          args: { calendar_entry_id, summary_changed: summary !== undefined, start_at, end_at, calendar_owner_id, description_changed: description !== undefined, all_day, matter_id, location_changed: location !== undefined, send_email_notification, attendee_count: attendee_ids?.length },
          outcome: "success",
          ...(entry.matter?.id && { matter_id: entry.matter.id }),
        });
        return { content: [{ type: "text", text: JSON.stringify({ success: true, entry: mapCalendarEntry(entry) }, null, 2) }] };
      } catch (err: any) {
        await appendAuditLog({ tool: "update_calendar_entry", args: { calendar_entry_id, start_at, end_at, calendar_owner_id, matter_id }, outcome: "error", error_message: err.message });
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "delete_calendar_entry",
    {
      description: "Permanently delete a Clio calendar entry",
      inputSchema: {
        calendar_entry_id: z.number().int().positive().describe("ID of the calendar entry to delete"),
      },
    },
    async ({ calendar_entry_id }) => {
      try {
        await clioDelete(`/calendar_entries/${calendar_entry_id}.json`);
        await appendAuditLog({ tool: "delete_calendar_entry", args: { calendar_entry_id }, outcome: "success" });
        return { content: [{ type: "text", text: JSON.stringify({ success: true, deleted_calendar_entry_id: calendar_entry_id }, null, 2) }] };
      } catch (err: any) {
        if (err instanceof ClioApiError && err.statusCode === 404) {
          await appendAuditLog({ tool: "delete_calendar_entry", args: { calendar_entry_id }, outcome: "success" });
          return { content: [{ type: "text", text: `Calendar entry ${calendar_entry_id} not found.` }] };
        }
        await appendAuditLog({ tool: "delete_calendar_entry", args: { calendar_entry_id }, outcome: "error", error_message: err.message });
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );
}
