import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn(), audit: vi.fn() }));
vi.mock("../../utils/clioClient.js", () => ({
  clioGet: mocks.get, clioPost: mocks.post, clioPatch: mocks.patch, clioDelete: mocks.del,
  extractNextPageToken: (meta: any) => meta?.paging?.next ? new URL(meta.paging.next).searchParams.get("page_token") : null,
}));
vi.mock("../../utils/auditLog.js", () => ({ appendAuditLog: mocks.audit }));
import { registerDocumentTemplateTools } from "../documentTemplates.js";
const handlers: Record<string, (args: any) => Promise<any>> = {};
registerDocumentTemplateTools({ registerTool(name: string, _schema: any, handler: any) { handlers[name] = handler; } } as any);
const read = (result: any) => JSON.parse(result.content[0].text);
beforeEach(() => {
  vi.resetAllMocks();
  mocks.get.mockResolvedValue({ data: { id: 42 } });
  mocks.post.mockResolvedValue({ data: { id: 42 } });
  mocks.patch.mockResolvedValue({ data: { id: 42 } });
});
describe("document templates", () => {
  it("registers all eight tools", () => expect(Object.keys(handlers)).toHaveLength(8));
  it("uses next cursor even for a short page and forwards cursor", async () => {
    mocks.get.mockResolvedValue({ data: [], meta: { paging: { next: "https://app.clio.com/api/v4/document_templates.json?page_token=next" } } });
    const result = read(await handlers.list_document_templates({ page_token: "previous" }));
    expect(result).toEqual({ templates: [], has_more: true, next_page_token: "next" });
    expect(mocks.get).toHaveBeenCalledWith("/document_templates.json", expect.objectContaining({ limit: "25", page_token: "previous" }));
  });
  it("reads selected metadata", async () => {
    expect(read(await handlers.get_document_template({ template_id: 42 }))).toEqual({ id: 42 });
    expect(mocks.get).toHaveBeenCalledWith("/document_templates/42.json", expect.objectContaining({ fields: expect.stringContaining("filename") }));
  });
  it("uploads base64 and explicitly requests response fields", async () => {
    await handlers.create_document_template({ file_base64: "dGVzdA==", filename: "test.docx", document_category_id: 2 });
    expect(mocks.post).toHaveBeenCalledWith("/document_templates.json", { data: { file: "dGVzdA==", filename: "test.docx", document_category: { id: 2 } } }, { fields: expect.stringContaining("id") });
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toMatch(/dGVzdA|test.docx/);
  });
  it.each(["", "bad", "data:application/docx;base64,dGVzdA=="])("rejects invalid base64 %s", async value => {
    expect((await handlers.create_document_template({ file_base64: value, filename: "test.docx" })).isError).toBe(true);
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it.each([{ template_id: 1 }, { template_id: 1, file_base64: "dGVzdA==" }])("rejects incomplete update %j", async args => {
    expect((await handlers.update_document_template(args)).isError).toBe(true);
    expect(mocks.patch).not.toHaveBeenCalled();
  });
  it("updates only supplied fields", async () => {
    await handlers.update_document_template({ template_id: 42, filename: "new.docx" });
    expect(mocks.patch).toHaveBeenCalledWith("/document_templates/42.json", { data: { filename: "new.docx" } }, expect.any(Object));
  });
  it("requires explicit deletion confirmation and handles 204", async () => {
    expect((await handlers.delete_document_template({ template_id: 42 })).isError).toBe(true);
    expect(mocks.del).not.toHaveBeenCalled();
    expect(read(await handlers.delete_document_template({ template_id: 42, confirm: true }))).toEqual({ deleted: true, template_id: 42 });
    expect(mocks.del).toHaveBeenCalledWith("/document_templates/42.json");
  });
  it.each([401, 403, 404, 422, 429])("surfaces API error %s without leaking API body to audit", async code => {
    mocks.get.mockRejectedValue(new Error(`${code}: private document name`));
    expect((await handlers.get_document_template({ template_id: 42 })).isError).toBe(true);
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain("private document name");
  });
});
describe("document automations", () => {
  it("creates a job with official payload, preserving pending state", async () => {
    mocks.post.mockResolvedValue({ data: { id: 7, state: "not_started", documents: [] } });
    expect(read(await handlers.create_document_automation({ template_id: 42, matter_id: 3, filename: "test", formats: ["original", "pdf"] }))).toEqual({ id: 7, state: "not_started", documents: [] });
    expect(mocks.post).toHaveBeenCalledWith("/document_automations.json", { data: { document_template: { id: 42 }, matter: { id: 3 }, filename: "test", formats: ["original", "pdf"] } }, { fields: expect.stringContaining("documents{") });
    expect(mocks.get).not.toHaveBeenCalled();
  });
  it.each([{ formats: [] }, { formats: ["docx"] }])("rejects invalid output formats %j", async ({ formats }) => {
    expect((await handlers.create_document_automation({ template_id: 42, matter_id: 3, filename: "test", formats })).isError).toBe(true);
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it("returns job state and generated IDs unchanged", async () => {
    const data = { id: 7, state: "completed", documents: [{ id: 8 }] };
    mocks.get.mockResolvedValue({ data });
    expect(read(await handlers.get_document_automation({ automation_id: 7 }))).toEqual(data);
    expect(mocks.get).toHaveBeenCalledWith("/document_automations/7.json", expect.any(Object));
  });
  it("lists empty jobs consistently", async () => {
    mocks.get.mockResolvedValue({ data: [] });
    expect(read(await handlers.list_document_automations({}))).toEqual({ automations: [], has_more: false, next_page_token: null });
  });
  it("does not retry uncertain writes", async () => {
    mocks.post.mockRejectedValue(new Error("network disconnected"));
    expect((await handlers.create_document_automation({ template_id: 42, matter_id: 3, filename: "test", formats: ["pdf"] })).isError).toBe(true);
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });
});
