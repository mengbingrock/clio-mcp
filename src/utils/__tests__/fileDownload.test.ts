import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ token: vi.fn(), context: vi.fn() }));
vi.mock("../../auth/oauth.js", () => ({ getValidAccessToken: mocks.token }));
vi.mock("../sessionContext.js", () => ({ requireSessionContext: mocks.context }));
import { clioFileDownloadUrl } from "../clioClient.js";
beforeEach(() => { vi.resetAllMocks(); mocks.context.mockReturnValue(null); mocks.token.mockResolvedValue("local-token"); vi.stubGlobal("fetch", vi.fn()); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const redirect = (url: string) => new Response(null, { status: 303, headers: { location: url } });
describe("binary redirects", () => {
  it("uses regional API/numeric version and auth only on Clio", async () => {
    vi.stubEnv("CLIO_REGION", "eu"); vi.stubEnv("CLIO_API_BASE", ""); (fetch as any).mockResolvedValue(redirect("https://bucket.s3.amazonaws.com/test?secret=signed"));
    expect(await clioFileDownloadUrl("documents", 42, 100)).toContain("amazonaws.com");
    expect(fetch).toHaveBeenCalledWith("https://eu.app.clio.com/api/v4/documents/42/download.json?document_version_id=100", expect.objectContaining({ redirect: "manual", headers: { Authorization: "Bearer local-token" } })); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("uses session token, never shared token", async () => {
    mocks.context.mockReturnValue({ getAccessToken: async () => "session-token" }); (fetch as any).mockResolvedValue(redirect("https://bucket.s3.amazonaws.com/file"));
    await clioFileDownloadUrl("document_templates", 42); expect(mocks.token).not.toHaveBeenCalled(); expect((fetch as any).mock.calls[0][1].headers.Authorization).toBe("Bearer session-token");
  });
  it("fails closed without session", async () => {
    mocks.context.mockImplementation(() => { throw new Error("missing session"); }); await expect(clioFileDownloadUrl("documents", 1)).rejects.toThrow(/session/); expect(fetch).not.toHaveBeenCalled(); expect(mocks.token).not.toHaveBeenCalled();
  });
  it.each(["http://bucket.s3.amazonaws.com/a", "https://localhost/a", "https://127.0.0.1/a", "https://user:pass@bucket.s3.amazonaws.com/a", "https://bucket.s3.amazonaws.com:8443/a", "https://amazonaws.com.evil.com/a", "https://evil.com/a", ""])("rejects unsafe target %s", async url => {
    (fetch as any).mockResolvedValue(redirect(url)); await expect(clioFileDownloadUrl("documents", 1)).rejects.toThrow(/redirect|host/);
  });
  it("does not expose API body", async () => {
    (fetch as any).mockResolvedValue(new Response("secret body", { status: 403 })); await expect(clioFileDownloadUrl("documents", 1)).rejects.toThrow(/HTTP 403/);
  });
  it.each([["documents", 0], ["documents", 1, -1], ["document_templates", 1, 2], ["evil", 1]])("rejects invalid identity", async (kind, id, version?: number) => {
    await expect(clioFileDownloadUrl(kind as any, id as number, version as number)).rejects.toThrow(/identity/); expect(fetch).not.toHaveBeenCalled();
  });
});
