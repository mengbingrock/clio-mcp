/**
 * The published tool count has been wrong three times (26, then 35, then 34),
 * on npm, in the MCP Registry and on the website, because it lives in prose and
 * prose does not fail CI. The README is what a firm reads before installing, so
 * the numbers in it are checked against the registry that decides them.
 */
import { vi, describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

vi.mock("@napi-rs/keyring", () => ({
  Entry: class {
    getPassword() { return null; }
    setPassword() {}
    deletePassword() {}
  },
}));

import { TOOL_META, WRITE_TOOLS } from "../index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

describe("README tool counts", () => {
  const sections = [...readme.matchAll(/^### .+ \((\d+) tools?\)$/gm)].map((m) => Number(m[1]));

  it("finds the per-section counts at all", () => {
    expect(sections.length).toBeGreaterThan(10);
  });

  it("sums to the number of tools the registry actually exposes", () => {
    const total = sections.reduce((a, b) => a + b, 0);
    expect(total, `README sections sum to ${total}, registry has ${Object.keys(TOOL_META).length}`)
      .toBe(Object.keys(TOOL_META).length);
  });

  it("states the same total in the npm package description", () => {
    const claimed = pkg.description.match(/(\d+) tools/);
    expect(claimed, "package.json description no longer states a tool count").not.toBeNull();
    expect(Number(claimed![1])).toBe(Object.keys(TOOL_META).length);
  });

  it("describes the read-only mode with the real number of write tools", () => {
    const written = readme.match(/never registers its ([a-z]+) write tools/);
    expect(written, "README no longer describes the read-only write-tool count").not.toBeNull();
    const words: Record<string, number> = {
      seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
      fifteen: 15,
    };
    expect(words[written![1]], `README says "${written![1]}" write tools`).toBe(WRITE_TOOLS.size);
  });
});
