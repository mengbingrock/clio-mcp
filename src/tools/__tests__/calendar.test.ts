import { vi, describe, it, expect, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const { mockClioGet, mockClioPost, mockClioPatch, mockClioDelete, mockAppendAuditLog, MockClioApiError } = vi.hoisted(() => ({
  mockClioGet: vi.fn(),
  mockClioPost: vi.fn(),
  mockClioPatch: vi.fn(),
  mockClioDelete: vi.fn(),
  mockAppendAuditLog: vi.fn().mockResolvedValue(undefined),
  MockClioApiError: class extends Error {
    constructor(public readonly statusCode: number, message: string) {
      super(message);
    }
  },
}));

vi.mock("../../utils/clioClient.js", () => ({
  clioGet: mockClioGet,
  clioPost: mockClioPost,
  clioPatch: mockClioPatch,
  clioDelete: mockClioDelete,
  ClioApiError: MockClioApiError,
  extractNextPageToken: (meta: any) => {
    const nextUrl = meta?.paging?.next;
    if (!nextUrl) return null;
    try { return new URL(nextUrl).searchParams.get("page_token"); }
    catch { return null; }
  },
}));

vi.mock("../../utils/auditLog.js", () => ({
  appendAuditLog: mockAppendAuditLog,
}));

import { toUtcIso, registerCalendarTools } from "../calendar.js";

function buildHandlers(): Record<string, Function> {
  const handlers: Record<string, Function> = {};
  const mockServer = {
    registerTool: vi.fn((name: string, _schema: unknown, handler: Function) => {
      handlers[name] = handler;
    }),
  } as unknown as McpServer;
  registerCalendarTools(mockServer);
  return handlers;
}

const FAKE_ENTRY = {
  id: 1,
  etag: "entry-etag",
  summary: "Deposition",
  description: "Prepare exhibits",
  location: "San Francisco",
  start_at: "2026-06-01T09:00:00Z",
  end_at: "2026-06-01T10:00:00Z",
  start_at_time_zone: "America/Los_Angeles",
  all_day: false,
  permission: "owner",
  calendar_owner_id: 7,
  calendar_owner: { id: 7, name: "Firm Calendar", type: "UserCalendar", color: "#367B9C" },
  matter: { id: 42, display_number: "00042-001" },
  attendees: [{ id: 9, type: "Calendar", name: "Lawyer", email: "lawyer@example.com", enabled: true }],
  reminders: [{ id: 10, duration: 30, state: "scheduled" }],
  created_at: "2026-05-01T10:00:00Z",
  updated_at: "2026-05-02T10:00:00Z",
};

const FROM = "2026-06-01T00:00:00-07:00";
const TO = "2026-07-01T00:00:00-07:00";

describe("list_calendar_entries", () => {
  let handlers: Record<string, Function>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAppendAuditLog.mockResolvedValue(undefined);
    handlers = buildHandlers();
  });

  it("returns has_more: false and next_page_token: null on a short final page", async () => {
    mockClioGet.mockResolvedValue({ data: [FAKE_ENTRY], meta: { records: 1, paging: {} } });
    const result = await handlers["list_calendar_entries"]({ from: FROM, to: TO, limit: 25 }) as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.has_more).toBe(false);
    expect(parsed.next_page_token).toBeNull();
  });

  it("returns has_more: true and the extracted token when a next page cursor is present", async () => {
    const twoEntries = [FAKE_ENTRY, { ...FAKE_ENTRY, id: 2 }];
    mockClioGet.mockResolvedValue({
      data: twoEntries,
      meta: { records: 10, paging: { next: "https://app.clio.com/api/v4/calendar_entries.json?page_token=abc123" } },
    });
    const result = await handlers["list_calendar_entries"]({ from: FROM, to: TO, limit: 2 }) as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.has_more).toBe(true);
    expect(parsed.next_page_token).toBe("abc123");
  });

  it("forwards page_token into the outgoing request params when supplied", async () => {
    mockClioGet.mockResolvedValue({ data: [FAKE_ENTRY], meta: { records: 1 } });
    await handlers["list_calendar_entries"]({ from: FROM, to: TO, limit: 25, page_token: "xyz" });
    expect(mockClioGet).toHaveBeenCalledWith(
      "/calendar_entries.json",
      expect.objectContaining({ page_token: "xyz" }),
    );
  });

  it("returns a JSON result with has_more: false when the page is empty, not a plain-text sentinel", async () => {
    mockClioGet.mockResolvedValue({ data: [], meta: { records: 0, paging: {} } });
    const result = await handlers["list_calendar_entries"]({ from: FROM, to: TO, limit: 25 }) as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.entries).toEqual([]);
    expect(parsed.has_more).toBe(false);
    expect(parsed.next_page_token).toBeNull();
  });

  it("normalizes range timestamps to UTC and forwards calendar and matter filters", async () => {
    mockClioGet.mockResolvedValue({ data: [FAKE_ENTRY], meta: { records: 1 } });
    await handlers["list_calendar_entries"]({ from: FROM, to: TO, calendar_id: 7, matter_id: 42, limit: 25 });
    expect(mockClioGet).toHaveBeenCalledWith(
      "/calendar_entries.json",
      expect.objectContaining({
        from: "2026-06-01T07:00:00.000Z",
        to: "2026-07-01T07:00:00.000Z",
        calendar_id: "7",
        matter_id: "42",
      }),
    );
  });
});

describe("get_calendar_entry", () => {
  let handlers: Record<string, Function>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAppendAuditLog.mockResolvedValue(undefined);
    handlers = buildHandlers();
  });

  it("returns complete calendar entry detail", async () => {
    mockClioGet.mockResolvedValue({ data: FAKE_ENTRY });
    const result = await handlers["get_calendar_entry"]({ calendar_entry_id: 1 }) as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toMatchObject({
      id: 1,
      etag: "entry-etag",
      description: "Prepare exhibits",
      location: "San Francisco",
      start_at_time_zone: "America/Los_Angeles",
      calendar_owner: { id: 7, name: "Firm Calendar" },
      matter: { id: 42, display_number: "00042-001" },
    });
    expect(parsed.attendees).toHaveLength(1);
    expect(parsed.reminders).toHaveLength(1);
  });

  it("returns a not-found message for a missing entry", async () => {
    mockClioGet.mockRejectedValue(new MockClioApiError(404, "not found"));
    const result = await handlers["get_calendar_entry"]({ calendar_entry_id: 404 }) as any;
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe("Calendar entry 404 not found.");
  });
});

const FAKE_CALENDAR = { id: 7, name: "Firm Calendar", type: "UserCalendar", color: "#ff0000", permission: "owner", visible: true };

describe("list_calendars", () => {
  let handlers: Record<string, Function>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAppendAuditLog.mockResolvedValue(undefined);
    handlers = buildHandlers();
  });

  it("returns has_more: false and next_page_token: null on a short final page", async () => {
    mockClioGet.mockResolvedValue({ data: [FAKE_CALENDAR], meta: { records: 1, paging: {} } });
    const result = await handlers["list_calendars"]({ limit: 25 }) as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.has_more).toBe(false);
    expect(parsed.next_page_token).toBeNull();
    expect(parsed.calendars[0]).toMatchObject({ permission: "owner", visible: true });
  });

  it("returns has_more: true and the extracted token when a next page cursor is present", async () => {
    const twoCalendars = [FAKE_CALENDAR, { ...FAKE_CALENDAR, id: 8 }];
    mockClioGet.mockResolvedValue({
      data: twoCalendars,
      meta: { records: 10, paging: { next: "https://app.clio.com/api/v4/calendars.json?page_token=abc123" } },
    });
    const result = await handlers["list_calendars"]({ limit: 2 }) as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.has_more).toBe(true);
    expect(parsed.next_page_token).toBe("abc123");
  });

  it("forwards page_token into the outgoing request params when supplied", async () => {
    mockClioGet.mockResolvedValue({ data: [FAKE_CALENDAR], meta: { records: 1 } });
    await handlers["list_calendars"]({ limit: 25, page_token: "xyz" });
    expect(mockClioGet).toHaveBeenCalledWith(
      "/calendars.json",
      expect.objectContaining({ page_token: "xyz" }),
    );
  });

  it("returns a JSON result with has_more: false when the page is empty, not a plain-text sentinel", async () => {
    mockClioGet.mockResolvedValue({ data: [], meta: { records: 0, paging: {} } });
    const result = await handlers["list_calendars"]({ limit: 25 }) as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.calendars).toEqual([]);
    expect(parsed.has_more).toBe(false);
    expect(parsed.next_page_token).toBeNull();
  });
});

describe("toUtcIso", () => {
  it("converts an offset-aware timestamp to UTC", () => {
    expect(toUtcIso("2026-06-01T09:00:00-07:00")).toBe("2026-06-01T16:00:00.000Z");
  });

  it("preserves the instant represented by a Z timestamp", () => {
    expect(toUtcIso("2026-06-01T09:00:00Z")).toBe("2026-06-01T09:00:00.000Z");
  });

  it("rejects date-only and local datetimes without a timezone", () => {
    expect(() => toUtcIso("2026-06-01")).toThrow(/explicit time-zone offset/);
    expect(() => toUtcIso("2026-06-01T09:00:00")).toThrow(/explicit time-zone offset/);
  });
});

describe("create_calendar_entry", () => {
  let handlers: Record<string, Function>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAppendAuditLog.mockResolvedValue(undefined);
    handlers = buildHandlers();
  });

  it("normalizes event timestamps to UTC", async () => {
    mockClioPost.mockResolvedValue({ data: FAKE_ENTRY });
    mockClioGet.mockResolvedValue({ data: FAKE_ENTRY });
    await handlers["create_calendar_entry"]({
      summary: "Deposition",
      start_at: "2026-06-01T09:00:00-07:00",
      end_at: "2026-06-01T10:00:00-07:00",
      calendar_owner_id: 7,
      matter_id: 42,
    });
    expect(mockClioPost).toHaveBeenCalledWith("/calendar_entries.json", {
      data: expect.objectContaining({
        start_at: "2026-06-01T16:00:00.000Z",
        end_at: "2026-06-01T17:00:00.000Z",
        calendar_owner: { id: 7 },
        matter: { id: 42 },
      }),
    });
    expect(mockClioGet).toHaveBeenCalledWith(
      "/calendar_entries/1.json",
      expect.objectContaining({ fields: expect.stringContaining("start_at_time_zone") }),
    );
  });
});

describe("update_calendar_entry", () => {
  let handlers: Record<string, Function>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAppendAuditLog.mockResolvedValue(undefined);
    handlers = buildHandlers();
  });

  it("reschedules an entry using UTC-normalized timestamps", async () => {
    mockClioPatch.mockResolvedValue({ data: FAKE_ENTRY });
    mockClioGet.mockResolvedValue({ data: FAKE_ENTRY });
    await handlers["update_calendar_entry"]({
      calendar_entry_id: 1,
      start_at: "2026-06-02T13:00:00-07:00",
      end_at: "2026-06-02T15:00:00-07:00",
      send_email_notification: false,
    });
    expect(mockClioPatch).toHaveBeenCalledWith("/calendar_entries/1.json", {
      data: {
        start_at: "2026-06-02T20:00:00.000Z",
        end_at: "2026-06-02T22:00:00.000Z",
        send_email_notification: false,
      },
    });
    expect(mockClioGet).toHaveBeenCalledWith(
      "/calendar_entries/1.json",
      expect.objectContaining({ fields: expect.stringContaining("start_at_time_zone") }),
    );
  });

  it("rejects an update with no changed fields", async () => {
    const result = await handlers["update_calendar_entry"]({ calendar_entry_id: 1 }) as any;
    expect(result.isError).toBe(true);
    expect(mockClioPatch).not.toHaveBeenCalled();
  });
});

describe("delete_calendar_entry", () => {
  let handlers: Record<string, Function>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAppendAuditLog.mockResolvedValue(undefined);
    handlers = buildHandlers();
  });

  it("deletes the requested entry and returns its ID", async () => {
    mockClioDelete.mockResolvedValue(undefined);
    const result = await handlers["delete_calendar_entry"]({ calendar_entry_id: 1 }) as any;
    expect(mockClioDelete).toHaveBeenCalledWith("/calendar_entries/1.json");
    expect(JSON.parse(result.content[0].text)).toEqual({ success: true, deleted_calendar_entry_id: 1 });
  });

  it("returns a not-found message when the entry is already absent", async () => {
    mockClioDelete.mockRejectedValue(new MockClioApiError(404, "not found"));
    const result = await handlers["delete_calendar_entry"]({ calendar_entry_id: 404 }) as any;
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe("Calendar entry 404 not found.");
  });
});
