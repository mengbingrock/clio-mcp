import { extractNextPageToken } from "./clioClient.js";

/** One successful API page, not certification of an entire review or Firm Feed. */
export function readProvenance(endpoint: string, params: Record<string, string>, response: any) {
  if (!Array.isArray(response?.data)) throw new Error("Clio did not return a record array; activity coverage is unknown.");
  const next = extractNextPageToken(response.meta);
  if (response.meta?.paging?.next && !next) throw new Error("Clio returned an unreadable next-page cursor; coverage is incomplete.");
  const { fields, ...filters } = params;
  return {
    retrieved_at: new Date().toISOString(), source_endpoint: endpoint, filters,
    page_complete: true, first_page: !params.page_token, last_page: next === null,
    all_pages_complete: !params.page_token && next === null,
    next_page_token: next, access_errors: [],
  };
}
