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

import { registerCustomFieldTools } from "../customFields.js";

const handlers: Record<string, Function> = {};
const fakeServer = {
  registerTool: vi.fn((name: string, _schema: any, handler: Function) => {
    handlers[name] = handler;
  }),
};

beforeAll(() => {
  registerCustomFieldTools(fakeServer as any);
});

const PICKLIST_FIELD = {
  id: 55003,
  name: "Case Type",
  field_type: "picklist",
  parent_type: "Matter",
  required: false,
  displayed: true,
  deleted: false,
  picklist_options: [
    { id: 9001, option: "Credit Reporting" },
    { id: 9002, option: "Identity Theft" },
  ],
};

const TEXT_FIELD = {
  id: 55001,
  name: "Docket Number",
  field_type: "text_line",
  parent_type: "Matter",
  required: false,
  displayed: true,
  deleted: false,
};

describe("list_custom_fields", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClioGetAllPages.mockResolvedValue([TEXT_FIELD, PICKLIST_FIELD]);
  });

  describe("request params", () => {
    it("calls the custom fields endpoint", async () => {
      await handlers["list_custom_fields"]({ include_deleted: false });
      expect(mockClioGetAllPages.mock.calls[0][0]).toBe("/custom_fields.json");
    });

    it("filters by parent_type when given", async () => {
      await handlers["list_custom_fields"]({ parent_type: "Matter", include_deleted: false });
      expect(mockClioGetAllPages.mock.calls[0][1].parent_type).toBe("Matter");
    });

    it("omits parent_type so both matter and contact fields come back", async () => {
      await handlers["list_custom_fields"]({ include_deleted: false });
      expect(mockClioGetAllPages.mock.calls[0][1]).not.toHaveProperty("parent_type");
    });

    it("requests picklist options, which are what a write to the field needs", async () => {
      await handlers["list_custom_fields"]({ include_deleted: false });
      expect(mockClioGetAllPages.mock.calls[0][1].fields).toContain("picklist_options{id,option}");
    });

    it("reads every page, since a partial list sends callers hunting for a field that exists", async () => {
      await handlers["list_custom_fields"]({ include_deleted: false });
      // clioGetAllPages is the paginate-to-completion helper; using clioGet here
      // would silently cap the definitions at one page.
      expect(mockClioGetAllPages).toHaveBeenCalledTimes(1);
    });
  });

  describe("response mapping", () => {
    it("returns id, name, type and parent_type per field", async () => {
      const result = await handlers["list_custom_fields"]({ include_deleted: false }) as any;
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.custom_fields[0]).toMatchObject({
        id: 55001,
        name: "Docket Number",
        type: "text_line",
        parent_type: "Matter",
      });
    });

    it("includes picklist options for picklist fields", async () => {
      const result = await handlers["list_custom_fields"]({ include_deleted: false }) as any;
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.custom_fields[1].picklist_options).toEqual([
        { id: 9001, option: "Credit Reporting" },
        { id: 9002, option: "Identity Theft" },
      ]);
    });

    it("omits picklist_options entirely for non-picklist fields", async () => {
      const result = await handlers["list_custom_fields"]({ include_deleted: false }) as any;
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.custom_fields[0]).not.toHaveProperty("picklist_options");
    });
  });

  describe("deleted fields", () => {
    beforeEach(() => {
      mockClioGetAllPages.mockResolvedValue([TEXT_FIELD, { ...PICKLIST_FIELD, deleted: true }]);
    });

    it("hides deleted fields by default", async () => {
      const result = await handlers["list_custom_fields"]({ include_deleted: false }) as any;
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.custom_fields).toHaveLength(1);
      expect(parsed.custom_fields[0].id).toBe(55001);
    });

    it("includes and marks them when asked, since historical records still carry their values", async () => {
      const result = await handlers["list_custom_fields"]({ include_deleted: true }) as any;
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.custom_fields).toHaveLength(2);
      expect(parsed.custom_fields[1].deleted).toBe(true);
    });
  });

  describe("empty and error handling", () => {
    it("says so plainly when the account has no custom fields", async () => {
      mockClioGetAllPages.mockResolvedValue([]);
      const result = await handlers["list_custom_fields"]({ include_deleted: false }) as any;
      expect(result.content[0].text).toBe("No custom fields are configured on this account.");
    });

    it("returns an error result rather than throwing", async () => {
      mockClioGetAllPages.mockRejectedValue(new Error("boom"));
      const result = await handlers["list_custom_fields"]({ include_deleted: false }) as any;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("Error: boom");
    });
  });

  describe("audit log", () => {
    it("logs the call with its filters", async () => {
      await handlers["list_custom_fields"]({ parent_type: "Matter", include_deleted: false });
      expect(mockAppendAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ tool: "list_custom_fields", outcome: "success", result_count: 2 })
      );
    });

    it("logs failures too", async () => {
      mockClioGetAllPages.mockRejectedValue(new Error("boom"));
      await handlers["list_custom_fields"]({ include_deleted: false });
      expect(mockAppendAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ tool: "list_custom_fields", outcome: "error" })
      );
    });
  });
});


describe("list_custom_fields permission handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("explains a 403 instead of passing Clio's wording through on its own", async () => {
    mockClioGetAllPages.mockRejectedValue(
      new MockClioApiError(403, "User is forbidden from taking that action")
    );
    const result = await handlers["list_custom_fields"]({ include_deleted: false }) as any;

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("User is forbidden");
    // Says what we have observed and asks for a report. Deliberately does NOT
    // name a settings screen: the cause is unconfirmed and the two candidate
    // explanations point at different places.
    expect(result.content[0].text).toMatch(/not confirmed/);
    expect(result.content[0].text).toContain("github.com/oktopeak/clio-mcp/issues");
  });

  it("leaves other errors alone", async () => {
    mockClioGetAllPages.mockRejectedValue(new MockClioApiError(500, "upstream exploded"));
    const result = await handlers["list_custom_fields"]({ include_deleted: false }) as any;
    expect(result.content[0].text).toBe("Error: upstream exploded");
  });
});
