import { vi, describe, it, expect, beforeEach } from "vitest";
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() }));
vi.mock("../../utils/clioClient.js", () => ({ clioGet: mocks.get, clioPost: mocks.post, clioPatch: mocks.patch, clioDelete: mocks.del,
  extractNextPageToken: (m: any) => m?.paging?.next ? new URL(m.paging.next).searchParams.get("page_token") : null }));
vi.mock("../../utils/auditLog.js", () => ({ appendAuditLog: vi.fn().mockResolvedValue(undefined) }));
import { registerReminderTools } from "../reminders.js";
const user = { id: 1, email: "one@example.invalid", enabled: true, notification_methods: [{ id: 9, type: "Email", email_address: "one@example.invalid" }, { id: 10, type: "Popup" }] };
const reminder = { id: 30, etag: '"v1"', duration: 0, next_delivery_at: "2026-12-01T17:00:00Z", state: "rescheduling", subject: { id: 20, type: "CalendarEntry" } };
let handlers: Record<string, Function>;
beforeEach(() => {
  vi.resetAllMocks(); handlers = {};
  registerReminderTools({ registerTool: (name: string, _config: unknown, cb: Function) => { handlers[name] = cb; } } as any);
});
const parsed = (result: any) => JSON.parse(result.content[0].text);
describe("reminder delivery and recipient contracts", () => {
  it("looks up methods through the documented user expansion, not a fabricated endpoint", async () => {
    mocks.get.mockResolvedValue({ data: user });
    expect(parsed(await handlers.list_notification_methods({ user_id: 1 })).notification_methods[0].email_address).toBe(user.email);
    expect(mocks.get).toHaveBeenCalledWith("/users/1.json", expect.objectContaining({ fields: expect.stringContaining("notification_methods{") }));
  });
  it("creates an elapsed-offset reminder only after verifying recipient and subject", async () => {
    mocks.get.mockResolvedValueOnce({ data: user }).mockResolvedValueOnce({ data: { id: 20 } });
    mocks.post.mockResolvedValue({ data: reminder });
    expect(parsed(await handlers.create_reminder({ subject_id: 20, subject_type: "CalendarEntry", user_id: 1, notification_method_id: 9, duration_unit: "minutes", duration_value: 0 })).id).toBe(30);
    expect(mocks.post).toHaveBeenCalledWith("/reminders.json", { data: { subject: { id: 20, type: "CalendarEntry" }, notification_method: { id: 9 }, duration_unit: "minutes", duration_value: 0 } }, expect.anything());
  });
  it("does not send using another user's method or a popup to another user", async () => {
    mocks.get.mockResolvedValue({ data: user });
    expect((await handlers.create_reminder({ subject_id: 20, subject_type: "CalendarEntry", user_id: 1, notification_method_id: 999, duration_unit: "days", duration_value: 1 })).isError).toBe(true);
    mocks.get.mockResolvedValueOnce({ data: user }).mockResolvedValueOnce({ data: { ...user, id: 2 } });
    expect((await handlers.create_reminder({ subject_id: 20, subject_type: "CalendarEntry", user_id: 1, notification_method_id: 10, duration_unit: "days", duration_value: 1 })).isError).toBe(true);
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it("requires the polymorphic subject type and preserves pagination/delivery state", async () => {
    expect((await handlers.list_reminders({ subject_id: 20 })).isError).toBe(true); expect(mocks.get).not.toHaveBeenCalled();
    mocks.get.mockResolvedValue({ data: [reminder], meta: { paging: { next: "https://app.clio.com/api/v4/reminders.json?page_token=next" } } });
    const r = parsed(await handlers.list_reminders({ subject_id: 20, subject_type: "calendar_entry", limit: 25 }));
    expect(r.reminders[0].state).toBe("rescheduling");expect(r.next_page_token).toBe("next");
  });
  it("guards versions and passes If-Match; asynchronous scheduling remains visible", async () => {
    mocks.get.mockResolvedValue({ data: reminder });mocks.patch.mockResolvedValue({ data: reminder });
    expect((await handlers.update_reminder({ reminder_id: 30, expected_etag: "stale", duration_unit: "minutes", duration_value: 15 })).isError).toBe(true);
    expect(mocks.patch).not.toHaveBeenCalled();
    expect(parsed(await handlers.update_reminder({ reminder_id: 30, expected_etag: reminder.etag, duration_unit: "minutes", duration_value: 15 })).state).toBe("rescheduling");
    expect(mocks.patch).toHaveBeenCalledWith("/reminders/30.json", { data: { duration_unit: "minutes", duration_value: 15 } }, expect.anything(), { ifMatch: reminder.etag });
  });
  it("does not issue empty or partial duration updates", async () => {
    for (const args of [{ reminder_id: 30 }, { reminder_id: 30, duration_unit: "days" }, { reminder_id: 30, notification_method_id: 9 }]) expect((await handlers.update_reminder(args)).isError).toBe(true);
    expect(mocks.patch).not.toHaveBeenCalled();
  });
  it("deletes only the specified reminder and propagates permission failures", async () => {
    await handlers.delete_reminder({ reminder_id: 30 });expect(mocks.del).toHaveBeenCalledWith("/reminders/30.json");
    mocks.get.mockRejectedValue(Error("Clio API 403"));expect((await handlers.get_reminder({ reminder_id: 30 })).isError).toBe(true);
  });
});
