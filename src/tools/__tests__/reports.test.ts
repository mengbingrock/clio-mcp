import { vi, it, expect, beforeEach } from "vitest";
import z from "zod";
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), download: vi.fn(), audit: vi.fn() }));
vi.mock("../../utils/clioClient.js", () => ({
  clioGet: mocks.get, clioPost: mocks.post, clioReportDownloadUrl: mocks.download,
  extractNextPageToken: (meta: any) => meta?.paging?.next ? new URL(meta.paging.next).searchParams.get("page_token") : null,
}));
vi.mock("../../utils/auditLog.js", () => ({ appendAuditLog: mocks.audit }));
import { registerReportTools, createReportSchema } from "../reports.js";
const handlers: Record<string, any> = {};
registerReportTools({ registerTool: (name: string, config: any, cb: any) => {
  handlers[name] = (args: any) => cb(z.object(config.inputSchema).parse(args));
} } as any);
beforeEach(() => { vi.clearAllMocks(); mocks.audit.mockResolvedValue(undefined); });
const period = { kind: "revenue", start_date: "2026-09-01", end_date: "2026-09-18" };
it("creates a dated report and maps filters to associations", async () => {
  mocks.post.mockResolvedValue({ data: { id: 1, state: "queued" } });
  const result = await handlers.create_report({ ...period, matter_id: 42 });
  expect(mocks.post).toHaveBeenCalledWith("/reports.json", { data: { ...period, format: "csv", matter: { id: 42 } } }, expect.any(Object));
  expect(JSON.parse(result.content[0].text).report.state).toBe("queued");
});
it("rejects invalid and reversed dates before writes", async () => {
  expect(createReportSchema.safeParse({ ...period, start_date: "2026-02-30" }).success).toBe(false);
  expect(createReportSchema.safeParse({ ...period, end_date: "tomorrow" }).success).toBe(false);
  const result = await handlers.create_report({ ...period, end_date: "2026-08-01" });
  expect(result.isError).toBe(true); expect(mocks.post).not.toHaveBeenCalled();
});
it("preserves manual pagination and filters", async () => {
  mocks.get.mockResolvedValue({ data: [{ id: 3 }], meta: { paging: { next: "https://app.clio.com/api/v4/reports.json?page_token=next" } } });
  const result = await handlers.list_reports({ kind: "revenue", limit: 2, page_token: "old" });
  expect(mocks.get).toHaveBeenCalledWith("/reports.json", expect.objectContaining({ kind: "revenue", limit: "2", page_token: "old" }));
  expect(JSON.parse(result.content[0].text)).toEqual({ reports: [{ id: 3 }], next_page_token: "next", has_more: true });
});
it.each(["queued", "in_progress", "failed", "empty", undefined])("does not download state %s", async state => {
  mocks.get.mockResolvedValue({ data: { id: 1, state } });
  expect((await handlers.download_report({ report_id: 1 })).isError).toBe(true);
  expect(mocks.download).not.toHaveBeenCalled();
});
it("returns a completed report URL without logging it", async () => {
  mocks.get.mockResolvedValue({ data: { id: 1, state: "completed", format: "csv" } });
  mocks.download.mockResolvedValue("https://storage.example/report?secret=abc");
  const result = await handlers.download_report({ report_id: 1 });
  expect(JSON.parse(result.content[0].text).download_url).toContain("https://storage.example/");
  expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain("secret");
});
it("reads report status and surfaces permission errors without recreating", async () => {
  mocks.get.mockResolvedValueOnce({ data: { id: 1, state: "in_progress" } });
  expect(JSON.parse((await handlers.get_report({ report_id: 1 })).content[0].text).state).toBe("in_progress");
  mocks.get.mockRejectedValue(new Error("403 Forbidden"));
  expect((await handlers.get_report({ report_id: 1 })).isError).toBe(true);
  expect(mocks.post).not.toHaveBeenCalled();
});
it("does not retry an uncertain creation", async () => {
  mocks.post.mockRejectedValue(new Error("connection lost"));
  expect((await handlers.create_report(period)).isError).toBe(true);
  expect(mocks.post).toHaveBeenCalledTimes(1);
});
