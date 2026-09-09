import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

const { mockClioGetAllPages, mockAppendAuditLog, MockClioApiError } = vi.hoisted(() => {
  class MockClioApiError extends Error {
    statusCode: number;
    constructor(statusCode: number, message: string) {
      super(message);
      this.statusCode = statusCode;
      this.name = "ClioApiError";
    }
  }
  return {
    mockClioGetAllPages: vi.fn(),
    mockAppendAuditLog: vi.fn().mockResolvedValue(undefined),
    MockClioApiError,
  };
});

vi.mock("../../utils/clioClient.js", () => ({
  clioGetAllPages: mockClioGetAllPages,
  ClioApiError: MockClioApiError,
}));

vi.mock("../../utils/auditLog.js", () => ({
  appendAuditLog: mockAppendAuditLog,
}));

import { registerMatterStageTools } from "../matterStages.js";

const handlers: Record<string, Function> = {};
const fakeServer = {
  registerTool: vi.fn((name: string, _schema: any, handler: Function) => {
    handlers[name] = handler;
  }),
};

beforeAll(() => {
  registerMatterStageTools(fakeServer as any);
});

function parse(result: any) {
  return JSON.parse(result.content[0].text);
}

describe("list_matter_stages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("request", () => {
    it("sends no fields parameter", async () => {
      // Clio 400s the whole request for one unknown field name, and nobody has
      // called this endpoint live. Defaults cannot be wrong.
      mockClioGetAllPages.mockResolvedValue([]);
      await handlers["list_matter_stages"]({});
      expect(mockClioGetAllPages.mock.calls[0][0]).toBe("/matter_stages.json");
      expect(mockClioGetAllPages.mock.calls[0][1]).not.toHaveProperty("fields");
    });

    it("passes practice_area_id through when given, and omits it otherwise", async () => {
      mockClioGetAllPages.mockResolvedValue([]);
      await handlers["list_matter_stages"]({ practice_area_id: 7 });
      expect(mockClioGetAllPages.mock.calls[0][1]).toEqual({ practice_area_id: "7" });

      await handlers["list_matter_stages"]({});
      expect(mockClioGetAllPages.mock.calls[1][1]).toEqual({});
    });
  });

  describe("mapping", () => {
    it("reads the practice area whether Clio sends an id or an association", async () => {
      mockClioGetAllPages.mockResolvedValue([
        { id: 1, name: "Pre-Suit", practice_area_id: 4, order: 1 },
        { id: 2, name: "Discovery", practice_area: { id: 4, name: "Consumer" }, order: 2 },
      ]);
      const stages = parse(await handlers["list_matter_stages"]({})).matter_stages;
      expect(stages[0].practice_area_id).toBe(4);
      expect(stages[1].practice_area_id).toBe(4);
      expect(stages[1].practice_area).toBe("Consumer");
    });

    it("groups by practice area and then follows the firm's pipeline order", async () => {
      mockClioGetAllPages.mockResolvedValue([
        { id: 3, name: "Settlement", practice_area_id: 4, order: 3 },
        { id: 9, name: "Intake", practice_area_id: 1, order: 1 },
        { id: 1, name: "Pre-Suit", practice_area_id: 4, order: 1 },
      ]);
      const stages = parse(await handlers["list_matter_stages"]({})).matter_stages;
      expect(stages.map((s: any) => s.name)).toEqual(["Intake", "Pre-Suit", "Settlement"]);
    });

    it("sorts stages with no practice area or order last instead of producing NaN", async () => {
      mockClioGetAllPages.mockResolvedValue([
        { id: 5, name: "Unfiled" },
        { id: 1, name: "Pre-Suit", practice_area_id: 4, order: 1 },
        { id: 2, name: "Discovery", practice_area_id: 4 },
      ]);
      const stages = parse(await handlers["list_matter_stages"]({})).matter_stages;
      expect(stages.map((s: any) => s.name)).toEqual(["Pre-Suit", "Discovery", "Unfiled"]);
      expect(stages[2].practice_area_id).toBeNull();
      expect(stages[2].order).toBeNull();
    });

    it("says so plainly when the account has no stages configured", async () => {
      mockClioGetAllPages.mockResolvedValue([]);
      const result = await handlers["list_matter_stages"]({}) as any;
      expect(result.content[0].text).toMatch(/No matter stages/);
      expect(result.isError).toBeUndefined();
    });
  });

  describe("errors", () => {
    it("explains a 403 rather than passing Clio's wording through alone", async () => {
      mockClioGetAllPages.mockRejectedValue(new MockClioApiError(403, "User is forbidden from taking that action"));
      const result = await handlers["list_matter_stages"]({}) as any;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("permission set");
      expect(result.content[0].text).toContain("github.com/oktopeak/clio-mcp/issues");
    });

    it("returns other failures as a result rather than throwing", async () => {
      mockClioGetAllPages.mockRejectedValue(new Error("boom"));
      const result = await handlers["list_matter_stages"]({}) as any;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("Error: boom");
    });
  });

  describe("audit log", () => {
    it("logs the call and the result count, never a stage name", async () => {
      mockClioGetAllPages.mockResolvedValue([{ id: 1, name: "CLIENTFACINGSTAGENAME", practice_area_id: 4, order: 1 }]);
      await handlers["list_matter_stages"]({ practice_area_id: 4 });

      const entry = mockAppendAuditLog.mock.calls.at(-1)![0];
      expect(entry).toMatchObject({ tool: "list_matter_stages", outcome: "success", result_count: 1 });
      expect(JSON.stringify(entry)).not.toContain("CLIENTFACINGSTAGENAME");
    });

    it("logs failures too", async () => {
      mockClioGetAllPages.mockRejectedValue(new Error("boom"));
      await handlers["list_matter_stages"]({});
      expect(mockAppendAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ tool: "list_matter_stages", outcome: "error" })
      );
    });
  });
});
