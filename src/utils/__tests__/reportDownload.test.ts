import { vi, it, expect, beforeEach, afterEach } from "vitest";
vi.mock("../../auth/oauth.js", () => ({ getValidAccessToken: vi.fn().mockResolvedValue("test-token") }));
vi.mock("../sessionContext.js", () => ({ requireSessionContext: vi.fn().mockReturnValue(null) }));
vi.mock("../clioRegion.js", () => ({ getClioApiBaseUrl: () => "https://eu.app.clio.com/api/v4" }));
import { clioReportDownloadUrl } from "../clioClient.js";
beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
afterEach(() => vi.unstubAllGlobals());
it("resolves 303 without following or forwarding the token to storage", async () => {
  vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 303, headers: { Location: "https://storage.example/report?signature=abc" } }));
  expect(await clioReportDownloadUrl(5)).toContain("https://storage.example/");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith("https://eu.app.clio.com/api/v4/reports/5/download.json", expect.objectContaining({ redirect: "manual" }));
});
it.each(["http://storage.example/file", "https://user:pass@storage.example/file", "/relative", "not a url"])("rejects unsafe location %s", async location => {
  vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 303, headers: { Location: location } }));
  await expect(clioReportDownloadUrl(5)).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
});
it.each([200, 403, 404, 422])("does not treat HTTP %s as download success", async status => {
  vi.mocked(fetch).mockResolvedValue(new Response("{}", { status }));
  await expect(clioReportDownloadUrl(5)).rejects.toThrow();
});
it("rejects missing location", async () => {
  vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 303 }));
  await expect(clioReportDownloadUrl(5)).rejects.toThrow("missing Location");
});
