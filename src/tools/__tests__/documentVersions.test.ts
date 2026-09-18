import { vi, describe, it, expect, beforeEach } from "vitest";
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), stat: vi.fn(), read: vi.fn(), audit: vi.fn(), fetch: vi.fn() }));
vi.mock("../../utils/clioClient.js", () => ({ clioGet: mocks.get, clioPost: mocks.post, clioPatch: mocks.patch, extractNextPageToken: (m: any) => m?.next ?? null }));
vi.mock("../../utils/auditLog.js", () => ({ appendAuditLog: mocks.audit }));
vi.mock("fs/promises", () => ({ default: { stat: mocks.stat, readFile: mocks.read } }));
import { registerDocumentVersionTools } from "../documentVersions.js";
const handlers: Record<string, Function> = {};
registerDocumentVersionTools({ registerTool: (n: string, _: any, h: Function) => { handlers[n] = h; } } as any);
const before = { id: 42, name: "test.docx", content_type: "application/test", parent: { id: 7, type: "Folder" }, matter: { id: 8 }, latest_document_version: { uuid: "old", fully_uploaded: true } };
const after = { ...before, latest_document_version: { uuid: "new", fully_uploaded: true, size: 3, version_number: 2 } };
const created = { data: { id: 42, latest_document_version: { uuid: "new", multiparts: [{ part_number: 1, put_url: "https://bucket.s3.amazonaws.com/object?signature=private" }], put_headers: [{ name: "Content-Type", value: "application/test" }] } } };
const args = { document_id: 42, expected_version_uuid: "old", file_path: "/private/test.docx" };
const call = () => handlers.upload_document_version(args);
const parse = (r: any) => JSON.parse(r.content[0].text);
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.get.mockResolvedValueOnce({ data: before }).mockResolvedValue({ data: after });
  mocks.post.mockResolvedValue(created);
  mocks.stat.mockResolvedValue({ size: 3, isFile: () => true });
  mocks.read.mockResolvedValue(Buffer.from("abc"));
  mocks.fetch.mockResolvedValue({ ok: true });
});
describe("document version upload", () => {
  it("creates a revision under Document, finalizes and verifies without moving or renaming", async () => {
    const r = await call(); expect(r.isError).toBeUndefined();
    expect(mocks.post.mock.calls[0][1].data.parent).toEqual({ type: "Document", id: 42 });
    expect(mocks.patch.mock.calls[0][1]).toEqual({ data: { uuid: "new", fully_uploaded: true } });
    expect(parse(r)).toMatchObject({ document_id: 42, previous_version_uuid: "old", version_uuid: "new", verified: true, version_number: 2 });
    expect(mocks.fetch.mock.calls[0][1].headers.Authorization).toBeUndefined();
    expect(mocks.fetch.mock.calls[0][1].redirect).toBe("error");
  });
  it("uses per-part signed headers, never version-level single-upload headers", async () => {
    mocks.post.mockResolvedValue({ data: { id: 42, latest_document_version: { uuid: "new", put_headers: [{ name: "x-amz-server-side-encryption", value: "AES256" }], multiparts: [{ part_number: 1, put_url: "https://bucket.s3.amazonaws.com/object", put_headers: [{ name: "Content-MD5", value: "signed-md5" }] }] } } });
    expect((await call()).isError).toBeUndefined();
    expect(mocks.fetch.mock.calls[0][1].headers).toEqual({ "Content-MD5": "signed-md5" });
  });
  it("blocks stale source before any write", async () => {
    mocks.get.mockReset().mockResolvedValue({ data: { ...before, latest_document_version: { uuid: "other", fully_uploaded: true } } });
    expect((await call()).isError).toBe(true); expect(mocks.post).not.toHaveBeenCalled();
  });
  it("blocks incomplete current source", async () => {
    mocks.get.mockReset().mockResolvedValue({ data: { ...before, latest_document_version: { uuid: "old", fully_uploaded: false } } });
    expect((await call()).isError).toBe(true); expect(mocks.post).not.toHaveBeenCalled();
  });
  it.each([0, 51 * 1024 * 1024])("blocks invalid size %s", async size => {
    mocks.stat.mockResolvedValue({ size, isFile: () => true });
    expect((await call()).isError).toBe(true); expect(mocks.post).not.toHaveBeenCalled();
  });
  it("does not finalize a different document", async () => {
    mocks.post.mockResolvedValue({ data: { ...created.data, id: 99 } });
    expect((await call()).isError).toBe(true); expect(mocks.fetch).not.toHaveBeenCalled(); expect(mocks.patch).not.toHaveBeenCalled();
  });
  it("does not finalize missing multipart instructions", async () => {
    mocks.post.mockResolvedValue({ data: { id: 42, latest_document_version: { uuid: "new", multiparts: [] } } });
    expect((await call()).isError).toBe(true); expect(mocks.patch).not.toHaveBeenCalled();
  });
  it("reports uncertain create without retrying", async () => {
    mocks.post.mockRejectedValue(new Error("network"));
    const r = await call(); expect(parse(r)).toMatchObject({ write_attempted: true, phase: "create_version" }); expect(mocks.post).toHaveBeenCalledTimes(1);
  });
  it("reports partial version without finalizing after storage failure", async () => {
    mocks.fetch.mockRejectedValue(new Error("private signed URL"));
    const r = await call(); expect(r.isError).toBe(true); expect(parse(r).version_uuid).toBe("new"); expect(mocks.patch).not.toHaveBeenCalled(); expect(JSON.stringify(r)).not.toContain("private signed URL");
  });
  it("rejects unexpected upload host", async () => {
    mocks.post.mockResolvedValue({ data: { id: 42, latest_document_version: { uuid: "new", multiparts: [{ part_number: 1, put_url: "https://example.com/file" }] } } });
    expect((await call()).isError).toBe(true); expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it.each([
    { ...after, parent: { id: 99, type: "Folder" } },
    { ...after, name: "changed.docx" },
    { ...after, latest_document_version: { ...after.latest_document_version, uuid: "other" } },
    { ...after, latest_document_version: { ...after.latest_document_version, size: 99 } },
  ])("does not claim success for mismatched readback", async doc => {
    mocks.get.mockReset().mockResolvedValueOnce({ data: before }).mockResolvedValueOnce({ data: doc });
    const r = await call(); expect(r.isError).toBe(true); expect(parse(r).phase).toBe("verify");
  });
  it("keeps pagination even for a short history page", async () => {
    mocks.get.mockReset().mockResolvedValue({ data: [{ uuid: "old" }], meta: { next: "cursor" } });
    const r = await handlers.list_document_versions({ document_id: 42, limit: 100 });
    expect(parse(r)).toMatchObject({ has_more: true, next_page_token: "cursor" });
  });
});
