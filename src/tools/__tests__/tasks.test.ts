import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

const { mockClioGet, mockClioPost, mockClioPatch, mockAppendAuditLog, MockClioApiError } = vi.hoisted(() => ({
  mockClioGet: vi.fn(),
  mockClioPost: vi.fn(),
  mockClioPatch: vi.fn(),
  mockAppendAuditLog: vi.fn().mockResolvedValue(undefined),
  MockClioApiError: class extends Error {
    constructor(public readonly statusCode: number, message: string) {
      super(message);
    }
  },
}));

vi.mock("../../utils/clioClient.js", () => ({
  clioGet: mockClioGet,
  clioPost: mockClioPost,
  clioPatch: mockClioPatch,
  ClioApiError: MockClioApiError,
  extractNextPageToken: (meta: any) => {
    const nextUrl = meta?.paging?.next;
    if (!nextUrl) return null;
    try { return new URL(nextUrl).searchParams.get("page_token"); }
    catch { return null; }
  },
}));

vi.mock("../../utils/auditLog.js", () => ({
  appendAuditLog: mockAppendAuditLog,
}));

import { registerTaskTools } from "../tasks.js";

const TASK_FIXTURE = {
  id: 1,
  name: "Draft contract",
  priority: "Normal",
  status: "complete",
  description: "Review every exhibit before filing.",
  description_text_type: "plain_text",
  due_at: "2026-01-15T17:00:00-08:00",
  completed_at: "2026-05-22T10:00:00Z",
  permission: "private",
  notify_completion: true,
  statute_of_limitations: false,
  time_estimated: 120,
  time_entries_count: 1,
  task_type: { id: 8, name: "Drafting" },
  assigner: { id: 5, name: "Assigning Lawyer" },
  assignee: { id: 6, type: "User", name: "Assigned Lawyer" },
  reminders: [{ id: 7, duration: 30, state: "scheduled", next_delivery_at: "2026-01-15T16:30:00-08:00" }],
  matter: { id: 99, display_number: "MAT-99" },
  created_at: "2026-01-01T10:00:00Z",
  updated_at: "2026-01-02T10:00:00Z",
};

const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
const toolSchemas = new Map<string, any>();

beforeAll(() => {
  const fakeServer = {
    registerTool: (name: string, _schema: unknown, handler: (args: Record<string, unknown>) => Promise<unknown>) => {
      toolSchemas.set(name, _schema);
      handlers.set(name, handler);
    },
  };
  registerTaskTools(fakeServer as any);
});

beforeEach(() => {
  vi.clearAllMocks();
  mockAppendAuditLog.mockResolvedValue(undefined);
});

// ─── list_tasks ───────────────────────────────────────────────────────────────

describe("list_tasks", () => {
  it("returns has_more: false and next_page_token: null on a short final page", async () => {
    mockClioGet.mockResolvedValue({ data: [TASK_FIXTURE], meta: { records: 1, paging: {} } });
    const handler = handlers.get("list_tasks")!;
    const result = await handler({ limit: 25 }) as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.has_more).toBe(false);
    expect(parsed.next_page_token).toBeNull();
  });

  it("returns has_more: true and the extracted token when a next page cursor is present", async () => {
    const twoTasks = [TASK_FIXTURE, { ...TASK_FIXTURE, id: 2 }];
    mockClioGet.mockResolvedValue({
      data: twoTasks,
      meta: { records: 10, paging: { next: "https://app.clio.com/api/v4/tasks.json?page_token=abc123" } },
    });
    const handler = handlers.get("list_tasks")!;
    const result = await handler({ limit: 2 }) as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.has_more).toBe(true);
    expect(parsed.next_page_token).toBe("abc123");
  });

  it("forwards page_token into the outgoing request params when supplied", async () => {
    mockClioGet.mockResolvedValue({ data: [TASK_FIXTURE], meta: { records: 1 } });
    const handler = handlers.get("list_tasks")!;
    await handler({ limit: 25, page_token: "xyz" });
    expect(mockClioGet).toHaveBeenCalledWith(
      "/tasks.json",
      expect.objectContaining({ page_token: "xyz" }),
    );
  });

  it("returns a JSON result with has_more: false when the page is empty, not a plain-text sentinel", async () => {
    mockClioGet.mockResolvedValue({ data: [], meta: { records: 0, paging: {} } });
    const handler = handlers.get("list_tasks")!;
    const result = await handler({ limit: 25 }) as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.tasks).toEqual([]);
    expect(parsed.has_more).toBe(false);
    expect(parsed.next_page_token).toBeNull();
  });

  it("preserves the full due_at timestamp instead of truncating it to a date", async () => {
    mockClioGet.mockResolvedValue({ data: [TASK_FIXTURE], meta: { records: 1 } });
    const handler = handlers.get("list_tasks")!;
    const result = await handler({ limit: 25 }) as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.tasks[0].due_at).toBe("2026-01-15T17:00:00-08:00");
    expect(parsed.tasks[0].due_date).toBe("2026-01-15");
  });
});

// ─── get_task ────────────────────────────────────────────────────────────────

describe("get_task", () => {
  it("returns full task detail including description, estimate, notifications, and permission", async () => {
    mockClioGet.mockResolvedValue({ data: TASK_FIXTURE });
    const handler = handlers.get("get_task")!;
    const result = await handler({ task_id: 1 }) as any;
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed).toMatchObject({
      id: 1,
      description: "Review every exhibit before filing.",
      due_at: "2026-01-15T17:00:00-08:00",
      time_estimated: 120,
      time_estimated_unit: "minutes",
      notify_completion: true,
      permission: "private",
      assignee: { id: 6, type: "User", name: "Assigned Lawyer" },
      matter: { id: 99, display_number: "MAT-99" },
    });
    expect(parsed.reminders).toHaveLength(1);
    expect(mockClioGet).toHaveBeenCalledWith(
      "/tasks/1.json",
      expect.objectContaining({ fields: expect.stringContaining("description") }),
    );
  });

  it("returns a not-found message without an MCP error for a missing task", async () => {
    mockClioGet.mockRejectedValue(new MockClioApiError(404, "not found"));
    const handler = handlers.get("get_task")!;
    const result = await handler({ task_id: 404 }) as any;
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe("Task 404 not found.");
  });
});

// ─── create_task ─────────────────────────────────────────────────────────────

describe("create_task", () => {
  it("requires due_at to be a valid ISO timestamp with an explicit offset", () => {
    const schema = toolSchemas.get("create_task").inputSchema.due_at;
    expect(schema.safeParse("2026-09-05T17:00:00-07:00").success).toBe(true);
    expect(schema.safeParse("2026-09-05T17:00:00").success).toBe(false);
    expect(schema.safeParse("2026-02-31T17:00:00-08:00").success).toBe(false);
  });

  it("passes an offset-aware due_at and task controls through unchanged", async () => {
    mockClioPost.mockResolvedValue({ data: TASK_FIXTURE });
    const handler = handlers.get("create_task")!;
    await handler({
      matter_id: 99,
      name: "Draft contract",
      description: "Review every exhibit before filing.",
      priority: "High",
      due_at: "2026-09-05T17:00:00-07:00",
      assignee_id: 6,
      time_estimated: 120,
      notify_assignee: true,
      notify_completion: true,
      permission: "private",
    });

    expect(mockClioPost).toHaveBeenCalledWith("/tasks.json", {
      data: expect.objectContaining({
        due_at: "2026-09-05T17:00:00-07:00",
        time_estimated: 120,
        notify_assignee: true,
        notify_completion: true,
        permission: "private",
      }),
    });
  });

  it("passes legacy due_date as a date without inventing UTC midnight", async () => {
    mockClioPost.mockResolvedValue({ data: TASK_FIXTURE });
    const handler = handlers.get("create_task")!;
    await handler({ matter_id: 99, name: "Draft", description: "Details", priority: "Normal", due_date: "2026-09-05" });
    expect(mockClioPost).toHaveBeenCalledWith(
      "/tasks.json",
      expect.objectContaining({ data: expect.objectContaining({ due_at: "2026-09-05" }) }),
    );
  });

  it("rejects ambiguous calls that provide both due_at and due_date", async () => {
    const handler = handlers.get("create_task")!;
    const result = await handler({
      matter_id: 99,
      name: "Draft",
      description: "Details",
      priority: "Normal",
      due_at: "2026-09-05T17:00:00-07:00",
      due_date: "2026-09-05",
    }) as any;
    expect(result.isError).toBe(true);
    expect(mockClioPost).not.toHaveBeenCalled();
  });
});

// ─── update_task ──────────────────────────────────────────────────────────────

describe("update_task", () => {
  it("returns isError without calling clioPatch when all fields are undefined", async () => {
    const handler = handlers.get("update_task")!;
    const result = await handler({ task_id: 1 }) as any;
    expect(mockClioPatch).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
  });

  it("translates status 'Complete' via STATUS_MAP to 'complete'", async () => {
    mockClioPatch.mockResolvedValue({ data: TASK_FIXTURE });
    const handler = handlers.get("update_task")!;
    await handler({ task_id: 1, status: "Complete" });
    expect(mockClioPatch).toHaveBeenCalledWith(
      "/tasks/1.json",
      expect.objectContaining({ data: expect.objectContaining({ status: "complete" }) }),
    );
  });

  it("translates status 'In Progress' via STATUS_MAP to 'in_progress'", async () => {
    mockClioPatch.mockResolvedValue({ data: TASK_FIXTURE });
    const handler = handlers.get("update_task")!;
    await handler({ task_id: 1, status: "In Progress" });
    expect(mockClioPatch).toHaveBeenCalledWith(
      "/tasks/1.json",
      expect.objectContaining({ data: expect.objectContaining({ status: "in_progress" }) }),
    );
  });

  it("passes legacy due_date as a date without inventing UTC midnight", async () => {
    mockClioPatch.mockResolvedValue({ data: TASK_FIXTURE });
    const handler = handlers.get("update_task")!;
    await handler({ task_id: 1, due_date: "2026-01-15" });
    expect(mockClioPatch).toHaveBeenCalledWith(
      "/tasks/1.json",
      expect.objectContaining({ data: expect.objectContaining({ due_at: "2026-01-15" }) }),
    );
  });

  it("passes offset-aware due_at, estimate, notifications, and permission unchanged", async () => {
    mockClioPatch.mockResolvedValue({ data: TASK_FIXTURE });
    const handler = handlers.get("update_task")!;
    await handler({
      task_id: 1,
      due_at: "2026-09-05T17:00:00-07:00",
      time_estimated: 120,
      notify_assignee: false,
      notify_completion: true,
      permission: "public",
    });
    expect(mockClioPatch).toHaveBeenCalledWith(
      "/tasks/1.json",
      expect.objectContaining({
        data: expect.objectContaining({
          due_at: "2026-09-05T17:00:00-07:00",
          time_estimated: 120,
          notify_assignee: false,
          notify_completion: true,
          permission: "public",
        }),
      }),
    );
  });

  it("rejects ambiguous calls that provide both due_at and due_date", async () => {
    const handler = handlers.get("update_task")!;
    const result = await handler({ task_id: 1, due_at: "2026-09-05T17:00:00-07:00", due_date: "2026-09-05" }) as any;
    expect(result.isError).toBe(true);
    expect(mockClioPatch).not.toHaveBeenCalled();
  });

  it("shapes assignee as { id, type: 'User' } when assignee_id is provided", async () => {
    mockClioPatch.mockResolvedValue({ data: TASK_FIXTURE });
    const handler = handlers.get("update_task")!;
    await handler({ task_id: 1, assignee_id: 42 });
    expect(mockClioPatch).toHaveBeenCalledWith(
      "/tasks/1.json",
      expect.objectContaining({ data: expect.objectContaining({ assignee: { id: 42, type: "User" } }) }),
    );
  });

  it("does not include assignee key when assignee_id is absent", async () => {
    mockClioPatch.mockResolvedValue({ data: TASK_FIXTURE });
    const handler = handlers.get("update_task")!;
    await handler({ task_id: 1, name: "New name" });
    const sentBody = mockClioPatch.mock.calls[0][1] as { data: Record<string, unknown> };
    expect(sentBody.data).not.toHaveProperty("assignee");
  });

  it("calls appendAuditLog with outcome 'success' on happy path", async () => {
    mockClioPatch.mockResolvedValue({ data: TASK_FIXTURE });
    const handler = handlers.get("update_task")!;
    await handler({ task_id: 1, name: "New name" });
    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "update_task", outcome: "success" }),
    );
  });

  it("returns isError and logs outcome 'error' when clioPatch rejects", async () => {
    mockClioPatch.mockRejectedValue(new Error("network failure"));
    const handler = handlers.get("update_task")!;
    const result = await handler({ task_id: 1, name: "X" }) as any;
    expect(result.isError).toBe(true);
    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "update_task", outcome: "error", error_message: "network failure" }),
    );
  });
});

// ─── complete_task ────────────────────────────────────────────────────────────

describe("complete_task", () => {
  it("calls clioPatch with status 'complete' from STATUS_MAP", async () => {
    mockClioPatch.mockResolvedValue({ data: TASK_FIXTURE });
    const handler = handlers.get("complete_task")!;
    await handler({ task_id: 1 });
    expect(mockClioPatch).toHaveBeenCalledWith("/tasks/1.json", { data: { status: "complete" } });
  });

  it("returns task shape with id, name, status, and completed_at", async () => {
    mockClioPatch.mockResolvedValue({ data: TASK_FIXTURE });
    const handler = handlers.get("complete_task")!;
    const result = await handler({ task_id: 1 }) as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toMatchObject({
      success: true,
      task: { id: 1, name: "Draft contract", status: "complete", completed_at: "2026-05-22T10:00:00Z" },
    });
  });

  it("calls appendAuditLog with outcome 'success' on happy path", async () => {
    mockClioPatch.mockResolvedValue({ data: TASK_FIXTURE });
    const handler = handlers.get("complete_task")!;
    await handler({ task_id: 1 });
    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "complete_task", outcome: "success" }),
    );
  });

  it("returns isError and logs outcome 'error' when clioPatch rejects", async () => {
    mockClioPatch.mockRejectedValue(new Error("timeout"));
    const handler = handlers.get("complete_task")!;
    const result = await handler({ task_id: 1 }) as any;
    expect(result.isError).toBe(true);
    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "complete_task", outcome: "error", error_message: "timeout" }),
    );
  });
});
