import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

const {
  mockStat,
  mockClioGet,
  mockClioPost,
  mockClioPut,
  mockClioPatch,
  mockAppendAuditLog,
  MockClioApiError,
} = vi.hoisted(() => {
  class MockClioApiError extends Error {
    statusCode: number;
    constructor(statusCode: number, message: string) {
      super(message);
      this.statusCode = statusCode;
      this.name = "ClioApiError";
    }
  }
  return {
    mockStat: vi.fn(),
    mockClioGet: vi.fn(),
    mockClioPost: vi.fn(),
    mockClioPut: vi.fn(),
    mockClioPatch: vi.fn(),
    mockAppendAuditLog: vi.fn().mockResolvedValue(undefined),
    MockClioApiError,
  };
});

vi.mock("fs/promises", () => ({
  default: {
    stat: mockStat,
    open: vi.fn(),
  },
}));

vi.mock("../../utils/clioClient.js", () => ({
  clioGet: mockClioGet,
  clioPost: mockClioPost,
  clioPut: mockClioPut,
  clioPatch: mockClioPatch,
  getClioBaseUrl: vi.fn(() => "https://app.clio.com/api/v4"),
  extractNextPageToken: vi.fn(() => null),
  ClioApiError: MockClioApiError,
}));

vi.mock("../../utils/auditLog.js", () => ({
  appendAuditLog: mockAppendAuditLog,
}));

import { registerDocumentTools } from "../documents.js";

const handlers: Record<string, Function> = {};
const fakeServer = {
  registerTool: vi.fn((name: string, _schema: any, handler: Function) => {
    handlers[name] = handler;
  }),
};

beforeAll(() => {
  registerDocumentTools(fakeServer as any);
});

const FOLDER = {
  id: 100,
  name: "Test Subfolder",
  parent: { id: 999, type: "Folder" },
  matter: { id: 42, display_number: "00042-001" },
};

const DOCUMENT = {
  id: 500,
  name: "evidence.pdf",
  content_type: "application/pdf",
  size: 0,
  created_at: "2026-09-05T12:00:00Z",
  parent: { id: 100, type: "Folder", name: "Test Subfolder" },
  matter: { id: 42, display_number: "00042-001" },
  latest_document_version: { uuid: "version-uuid", created_at: "2026-09-05T12:00:00Z", size: 0 },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockStat.mockResolvedValue({ size: 0 });
  mockClioPost.mockResolvedValue({
    data: { id: 500, latest_document_version: { uuid: "version-uuid", multiparts: [] } },
  });
  mockClioPut.mockResolvedValue({ data: { multiparts: [] } });
  mockClioPatch.mockResolvedValue({});
});

describe("document parent readback", () => {
  it("returns the actual parent folder from get_document", async () => {
    mockClioGet.mockResolvedValue({ data: DOCUMENT });
    const result = await handlers["get_document"]({ document_id: 500 }) as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(mockClioGet.mock.calls[0][1].fields).toContain("parent{id,type,name}");
    expect(parsed.parent).toEqual({ id: 100, type: "Folder", name: "Test Subfolder" });
    expect(parsed.parent_folder).toEqual({ id: 100, name: "Test Subfolder" });
  });

  it("returns each actual parent from list_documents", async () => {
    mockClioGet.mockResolvedValue({ data: [DOCUMENT], meta: { records: 1 } });
    const result = await handlers["list_documents"]({ matter_id: 42, limit: 25 }) as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.documents[0].parent_folder).toEqual({ id: 100, name: "Test Subfolder" });
  });
});

describe("upload_document", () => {
  it("uploads to a folder only after verifying that it belongs to the matter", async () => {
    mockClioGet
      .mockResolvedValueOnce({ data: FOLDER })
      .mockResolvedValueOnce({ data: DOCUMENT });

    const result = await handlers["upload_document"]({
      file_path: "/tmp/evidence.pdf",
      matter_id: 42,
      folder_id: 100,
    }) as any;
    const parsed = JSON.parse(result.content[0].text);

    expect(mockClioGet.mock.calls[0]).toEqual([
      "/folders/100.json",
      expect.objectContaining({ fields: expect.stringContaining("matter{id,display_number}") }),
    ]);
    expect(mockClioPost.mock.calls[0][1].data.parent).toEqual({ id: 100, type: "Folder" });
    expect(parsed.requested_parent).toEqual({ id: 100, type: "Folder" });
    expect(parsed.parent_folder).toEqual({ id: 100, name: "Test Subfolder" });
    expect(parsed.parent_verified).toBe(true);
  });

  it("fails closed before creating a document when the folder belongs to another matter", async () => {
    mockClioGet.mockResolvedValue({ data: { ...FOLDER, matter: { id: 99 } } });
    const result = await handlers["upload_document"]({
      file_path: "/tmp/evidence.pdf",
      matter_id: 42,
      folder_id: 100,
    }) as any;

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("belongs to matter 99, not matter 42");
    expect(mockClioPost).not.toHaveBeenCalled();
  });

  it("fails closed when Clio does not return enough data to verify folder ownership", async () => {
    mockClioGet.mockResolvedValue({ data: { id: 100, name: "Unknown" } });
    const result = await handlers["upload_document"]({
      file_path: "/tmp/evidence.pdf",
      matter_id: 42,
      folder_id: 100,
    }) as any;

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Cannot verify");
    expect(mockClioPost).not.toHaveBeenCalled();
  });

  it("preserves matter-root uploads when folder_id is omitted", async () => {
    const rootDocument = { ...DOCUMENT, parent: { id: 42, type: "Matter", name: null } };
    mockClioGet.mockResolvedValue({ data: rootDocument });
    const result = await handlers["upload_document"]({
      file_path: "/tmp/evidence.pdf",
      matter_id: 42,
    }) as any;
    const parsed = JSON.parse(result.content[0].text);

    expect(mockClioPost.mock.calls[0][1].data.parent).toEqual({ id: 42, type: "Matter" });
    expect(parsed.parent_verified).toBe(true);
  });
});

describe("update_document", () => {
  it("renames a document and reads the actual parent back", async () => {
    mockClioGet.mockResolvedValue({ data: { ...DOCUMENT, name: "renamed.pdf" } });
    const result = await handlers["update_document"]({ document_id: 500, name: "renamed.pdf" }) as any;
    const parsed = JSON.parse(result.content[0].text);

    expect(mockClioPatch).toHaveBeenCalledWith("/documents/500.json", { data: { name: "renamed.pdf" } });
    expect(parsed.name).toBe("renamed.pdf");
    expect(parsed.parent_folder.id).toBe(100);
    expect(parsed.parent_verified).toBeNull();
  });

  it("moves a document only after verifying the target folder's matter", async () => {
    mockClioGet
      .mockResolvedValueOnce({ data: FOLDER })
      .mockResolvedValueOnce({ data: DOCUMENT });
    const result = await handlers["update_document"]({
      document_id: 500,
      matter_id: 42,
      folder_id: 100,
    }) as any;
    const parsed = JSON.parse(result.content[0].text);

    expect(mockClioPatch).toHaveBeenCalledWith("/documents/500.json", {
      data: { parent: { id: 100, type: "Folder" } },
    });
    expect(parsed.parent_verified).toBe(true);
  });

  it("moves a document to a matter root when only matter_id is supplied", async () => {
    mockClioGet.mockResolvedValue({
      data: { ...DOCUMENT, parent: { id: 42, type: "Matter", name: null } },
    });
    const result = await handlers["update_document"]({ document_id: 500, matter_id: 42 }) as any;
    const parsed = JSON.parse(result.content[0].text);

    expect(mockClioPatch).toHaveBeenCalledWith("/documents/500.json", {
      data: { parent: { id: 42, type: "Matter" } },
    });
    expect(parsed.parent_verified).toBe(true);
  });

  it("requires matter_id when folder_id is supplied", async () => {
    const result = await handlers["update_document"]({ document_id: 500, folder_id: 100 }) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("folder_id requires matter_id");
    expect(mockClioPatch).not.toHaveBeenCalled();
  });

  it("requires at least one rename or move operation", async () => {
    const result = await handlers["update_document"]({ document_id: 500 }) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("provide name and/or");
    expect(mockClioPatch).not.toHaveBeenCalled();
  });
});
