import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { get, audit } = vi.hoisted(() => ({ get: vi.fn(), audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../utils/clioClient.js", () => ({
  clioGet: get, clioPost: vi.fn(), clioPatch: vi.fn(), clioPut: vi.fn(), clioDelete: vi.fn(),
  ClioApiError: class extends Error {}, getClioBaseUrl: () => "https://app.clio.com/api/v4",
  extractNextPageToken: (meta: any) => meta?.paging?.next ? new URL(meta.paging.next).searchParams.get("page_token") : null,
}));
vi.mock("../../utils/auditLog.js", () => ({ appendAuditLog: audit }));
import { registerDocumentTools } from "../documents.js";
import { registerActivityTools } from "../activities.js";
import { registerTaskTools } from "../tasks.js";
import { registerNoteTools } from "../notes.js";
import { registerCalendarTools } from "../calendar.js";
import { registerCommunicationTools } from "../communications.js";

const handlers: Record<string, Function> = {};
const server: any = { registerTool(name: string, _schema: any, callback: Function) { handlers[name] = callback; } };
const parse = (r: any) => JSON.parse(r.content[0].text);
beforeAll(() => { for (const register of [registerDocumentTools, registerActivityTools, registerTaskTools, registerNoteTools, registerCalendarTools, registerCommunicationTools]) register(server); });
beforeEach(() => vi.clearAllMocks());

describe("API activity evidence", () => {
  it("preserves creator type and modified time without inventing a creator filter", async () => {
    get.mockResolvedValue({ data: [{ id: 1, creator: { id: 7, type: "ManageUser" }, updated_at: "2026-10-20T12:00:00Z" }] });
    const r = parse(await handlers.list_documents({ updated_since: "2026-10-20T00:00:00Z", limit: 2 }));
    expect(r.documents[0].creator).toEqual({ id: 7, type: "ManageUser" });
    expect(r.documents[0].updated_at).toBe("2026-10-20T12:00:00Z");
    expect(get.mock.calls[0][1].creator_id).toBeUndefined();
    expect(get.mock.calls[0][1].updated_since).toBe("2026-10-20T00:00:00Z");
  });
  it("uses supported version creator expansion, not a doubly nested latest-version expansion", async () => {
    get.mockResolvedValue({ data: { id: 1 } });
    await handlers.get_document({ document_id: 1 });
    expect(get.mock.calls[0][1].fields).toContain("creator{id,type,name}");
    expect(get.mock.calls[0][1].fields).not.toMatch(/latest_document_version\{[^}]*creator/);
    get.mockResolvedValue({ data: [{ id: 2, document_id: 1, creator: { id: 8, type: "ClientUser" } }] });
    const r = parse(await handlers.list_document_versions({ document_id: 1, limit: 2 }));
    expect(r.versions[0].creator.type).toBe("ClientUser");
  });
  it("does not discard the next cursor on short pages", async () => {
    get.mockResolvedValue({ data: [{ id: 1 }], meta: { paging: { next: "https://app.clio.com/api/v4/documents.json?page_token=next" } } });
    const r = parse(await handlers.list_documents({ matter_id: 42, limit: 200 }));
    expect(r.has_more).toBe(true);
    expect(r.next_page_token).toBe("next");
    expect(r.provenance.all_pages_complete).toBe(false);
  });
  it("keeps an empty page with a cursor distinguishable from a complete empty result", async () => {
    get.mockResolvedValue({ data: [], meta: { paging: { next: "https://app.clio.com/api/v4/notes.json?page_token=next" } } });
    const r = parse(await handlers.list_notes({ matter_id: 42, limit: 200 }));
    expect(r.notes).toEqual([]);
    expect(r.has_more).toBe(true);
    expect(r.provenance.all_pages_complete).toBe(false);
  });
  it("does not certify a final continuation page as an entire query", async () => {
    get.mockResolvedValue({ data: [] });
    const r = parse(await handlers.list_time_entries({ user_id: 7, limit: 200, page_token: "next" }));
    expect(r.provenance.last_page).toBe(true);
    expect(r.provenance.all_pages_complete).toBe(false);
  });
  it("returns an error for an unknown array instead of converting it to zero records", async () => {
    get.mockResolvedValue({ data: null });
    const r = await handlers.list_notes({ matter_id: 42, limit: 2 });
    expect(r.isError).toBe(true);
  });
  it("returns an error for a next link without a usable cursor", async () => {
    get.mockResolvedValue({ data: [], meta: { paging: { next: "https://app.clio.com/api/v4/notes.json" } } });
    expect((await handlers.list_notes({ matter_id: 42, limit: 2 })).isError).toBe(true);
  });
  it("preserves recorded-time flags, zero rates, employee scope and source links", async () => {
    get.mockResolvedValue({ data: [{ id: 1, type: "TimeEntry", date: "2026-10-20", user: { id: 7 }, price: 0, quantity_in_hours: 1,
      quantity_redacted: false, non_billable: false, no_charge: true, contingency_fee: true, document_version: { id: 90, document_id: 9 },
      created_at: "2026-10-21T01:00:00Z", updated_at: "2026-10-21T02:00:00Z" }] });
    const r = parse(await handlers.list_time_entries({ user_id: 7, start_date: "2026-10-20", end_date: "2026-10-20", limit: 200 }));
    expect(get.mock.calls[0][1].user_id).toBe("7");
    expect(r.time_entries[0]).toMatchObject({ price: 0, rate: 0, quantity_redacted: false, non_billable: false, no_charge: true, contingency_fee: true, document_version: { id: 90, document_id: 9 } });
    expect(r.provenance.filters.type).toBe("TimeEntry");
    expect(r.provenance.retrieved_at).toBeTruthy();
  });
  it("does not coerce missing flags or quantities to false or zero", async () => {
    get.mockResolvedValue({ data: [{ id: 1 }] });
    const e = parse(await handlers.list_time_entries({ limit: 2 })).time_entries[0];
    expect(e.quantity_redacted).toBeNull();
    expect(e.quantity_in_hours).toBeNull();
    expect(e.non_billable).toBeNull();
    expect(e.contingency_fee).toBeNull();
  });
  it("reuses task assigner/assignee and note authors while adding missing linked time", async () => {
    get.mockResolvedValue({ data: [{ id: 1, author: { id: 7 }, time_entries_count: 1, time_entries: [{ id: 20 }] }] });
    expect(parse(await handlers.list_notes({ matter_id: 42, limit: 2 })).notes[0]).toMatchObject({ author: { id: 7 }, time_entries_count: 1, time_entries: [{ id: 20 }] });
    get.mockResolvedValue({ data: [{ id: 2, assigner: { id: 8 }, assignee: { id: 7, type: "User" }, completed_at: "2026-10-20T12:00:00Z" }] });
    expect(parse(await handlers.list_tasks({ limit: 2 })).tasks[0]).toMatchObject({ assigner: { id: 8 }, assignee: { id: 7, type: "User" }, completed_at: "2026-10-20T12:00:00Z" });
  });
  it("keeps communication sender and record user distinct", async () => {
    get.mockResolvedValue({ data: [{ id: 1, senders: [{ id: 7, type: "User" }], user: { id: 8 }, time_entries_count: 1, time_entries: [{ id: 20 }] }] });
    const r = parse(await handlers.list_communications({ user_id: 8, limit: 2 }));
    expect(r.communications[0].senders[0].id).toBe(7);
    expect(r.communications[0].user.id).toBe(8);
  });
  it("preserves calendar date/timezone context without requiring write access", async () => {
    get.mockResolvedValue({ data: [{ id: "cal1", all_day: true, start_date: "2026-11-01", end_date: "2026-11-02", start_at_time_zone: "America/Los_Angeles" }] });
    const r = parse(await handlers.list_calendar_entries({ from: "2026-11-01T00:00:00-07:00", to: "2026-11-02T00:00:00-08:00", limit: 2 }));
    expect(r.entries[0]).toMatchObject({ all_day: true, start_date: "2026-11-01", end_date: "2026-11-02", time_entries_count: null });
    get.mockResolvedValue({ data: [] });
    await handlers.list_calendars({ limit: 2 });
    expect(get.mock.calls.at(-1)![1].writeable).toBeUndefined();
  });
});
