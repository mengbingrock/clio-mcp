import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
const mocks = vi.hoisted(() => ({ get: vi.fn(), all: vi.fn(), url: vi.fn(), audit: vi.fn(), stdio: vi.fn(), ctx: vi.fn() }));
vi.mock("../../utils/clioClient.js", () => ({ clioGet: mocks.get, clioGetAllPages: mocks.all, clioFileDownloadUrl: mocks.url }));
vi.mock("../../utils/auditLog.js", () => ({ appendAuditLog: mocks.audit }));
vi.mock("../../utils/sessionContext.js", () => ({ isStdioMode: mocks.stdio, getSessionContext: mocks.ctx }));
import { registerDocumentDownloadTools, fetchDownloadBytes } from "../documentDownloads.js";
const handlers: Record<string, (args: any) => Promise<any>> = {};
registerDocumentDownloadTools({ registerTool(name: string, _cfg: any, cb: any) { handlers[name] = cb; } } as any);
const parse = (r: any) => JSON.parse(r.content[0].text);
const bytes = Buffer.from("PK\x03\x04fixture");
const tpl = { id: 42, etag: "v1", filename: "private.docx", size: bytes.length, content_type: "application/docx" };
const old = { id: 101, document_id: 42, uuid: "old", fully_uploaded: true, size: bytes.length };
const latest = { ...old, id: 102, uuid: "latest" };
const doc = { id: 42, parent: { type: "Matter", id: 5 }, matter: { id: 5 }, latest_document_version: latest };
let dir: string;
beforeEach(async () => {
  vi.resetAllMocks(); dir = await fs.mkdtemp(path.join(os.tmpdir(), "clio-download-test-"));
  mocks.stdio.mockReturnValue(true); mocks.ctx.mockReturnValue(undefined);
  mocks.url.mockResolvedValue("https://bucket.s3.amazonaws.com/private?signature=secret");
  mocks.get.mockImplementation(async (p: string) => ({ data: p.startsWith("/document_templates") ? tpl : doc }));
  mocks.all.mockResolvedValue([old, latest]);
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(bytes, { headers: { "content-length": String(bytes.length) } })));
});
afterEach(async () => { vi.unstubAllGlobals(); await fs.rm(dir, { recursive: true, force: true }); });
const local = () => ({ template_id: 42, output_path: path.join(dir, "template.docx") });
describe("document downloads", () => {
  it("saves original bytes/hash without exposing storage URLs or audit paths", async () => {
    const r = parse(await handlers.download_document_template(local()));
    expect(r).toMatchObject({ downloaded: true, template_id: 42, size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") });
    expect(await fs.readFile(r.output_path)).toEqual(bytes);
    expect(mocks.url).toHaveBeenCalledWith("document_templates", 42);
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toMatch(/private|signature|secret|output_path/);
    expect(JSON.stringify(r)).not.toMatch(/signature|secret/);
    expect((fetch as any).mock.calls[0][1]).toMatchObject({ redirect: "error" });
    expect((fetch as any).mock.calls[0][1].headers).toBeUndefined();
  });
  it("hosted URL mode does not fetch or claim a local save", async () => {
    mocks.stdio.mockReturnValue(false); mocks.ctx.mockReturnValue({});
    expect(parse(await handlers.download_document_template({ template_id: 42 }))).toMatchObject({ downloaded: false, sensitive_url: true }); expect(fetch).not.toHaveBeenCalled();
  });
  it("blocks hosted filesystem writes before API access", async () => {
    mocks.ctx.mockReturnValue({}); expect((await handlers.download_document_template(local())).isError).toBe(true); expect(mocks.get).not.toHaveBeenCalled();
  });
  it("pins latest using numeric ID", async () => {
    expect(parse(await handlers.download_document({ document_id: 42, output_path: local().output_path }))).toMatchObject({ document_version_id: 102, version_uuid: "latest" });
    expect(mocks.url).toHaveBeenCalledWith("documents", 42, 102); expect(mocks.all).not.toHaveBeenCalled();
  });
  it("selects old version and rereads paginated membership", async () => {
    expect(parse(await handlers.download_document({ document_id: 42, document_version_id: 101, output_path: local().output_path }))).toMatchObject({ document_version_id: 101, version_uuid: "old" });
    expect(mocks.all).toHaveBeenCalledTimes(2); expect(mocks.url).toHaveBeenCalledWith("documents", 42, 101);
  });
  it.each([[], [{ ...old, document_id: 99 }], [{ ...old, fully_uploaded: false }]])("rejects absent/foreign/incomplete versions", async versions => {
    mocks.all.mockResolvedValue(versions); expect((await handlers.download_document({ document_id: 42, document_version_id: 101 })).isError).toBe(true); expect(mocks.url).not.toHaveBeenCalled();
  });
  it.each([0, -1, Number.MAX_SAFE_INTEGER + 1])("rejects unsafe IDs %s", async value => {
    expect((await handlers.download_document_template({ template_id: value })).isError).toBe(true); expect(mocks.get).not.toHaveBeenCalled();
  });
  it("rejects relative/existing paths without changing file", async () => {
    expect((await handlers.download_document_template({ template_id: 42, output_path: "relative.docx" })).isError).toBe(true);
    await fs.writeFile(local().output_path, "keep"); expect((await handlers.download_document_template(local())).isError).toBe(true);
    expect(await fs.readFile(local().output_path, "utf8")).toBe("keep");
  });
  it("rejects symlink destination", async () => {
    await fs.symlink(path.join(dir, "target"), local().output_path); expect((await handlers.download_document_template(local())).isError).toBe(true); expect(fetch).not.toHaveBeenCalled();
  });
  it("detects template mutation and leaves no output", async () => {
    mocks.get.mockResolvedValueOnce({ data: tpl }).mockResolvedValueOnce({ data: { ...tpl, etag: "changed" } });
    expect((await handlers.download_document_template(local())).isError).toBe(true); await expect(fs.stat(local().output_path)).rejects.toThrow();
  });
  it("detects latest mutation and leaves no output", async () => {
    mocks.get.mockResolvedValueOnce({ data: doc }).mockResolvedValueOnce({ data: { ...doc, latest_document_version: { ...latest, uuid: "changed" } } });
    expect((await handlers.download_document({ document_id: 42, output_path: local().output_path })).isError).toBe(true); await expect(fs.stat(local().output_path)).rejects.toThrow();
  });
  it("sanitizes sensitive API/network errors", async () => {
    mocks.url.mockRejectedValue(new Error("private?signature=secret; sensitive API content")); const r = await handlers.download_document_template(local());
    expect(r.isError).toBe(true); expect(JSON.stringify([r, mocks.audit.mock.calls])).not.toMatch(/signature|secret|sensitive API content/);
  });
  it("refuses metadata over limit before fetch", async () => {
    expect((await handlers.download_document_template({ ...local(), max_bytes: 1 })).isError).toBe(true); expect(fetch).not.toHaveBeenCalled();
  });
  it("exclusive creation prevents concurrent overwrite", async () => {
    const results = await Promise.all([handlers.download_document_template(local()), handlers.download_document_template(local())]);
    expect(results.filter(r => !r.isError)).toHaveLength(1); expect(await fs.readFile(local().output_path)).toEqual(bytes);
  });
});
describe("bounded fetch", () => {
  it("rejects declared/streamed overflow and size mismatch", async () => {
    await expect(fetchDownloadBytes("https://unused", bytes.length, 1)).rejects.toThrow(/limit/);
    (fetch as any).mockResolvedValueOnce(new Response(bytes)); await expect(fetchDownloadBytes("https://unused", bytes.length, 1)).rejects.toThrow(/limit/);
    await expect(fetchDownloadBytes("https://unused", 100, 100)).rejects.toThrow(/size/);
  });
  it("rejects HTML and HTTP failures", async () => {
    const html = "<!doctype html><html>login</html>"; (fetch as any).mockResolvedValueOnce(new Response(html));
    await expect(fetchDownloadBytes("https://unused", html.length, 100)).rejects.toThrow(/HTML/);
    (fetch as any).mockResolvedValueOnce(new Response("sensitive", { status: 403 })); await expect(fetchDownloadBytes("https://unused", 9, 100)).rejects.toThrow(/HTTP 403/);
  });
});
