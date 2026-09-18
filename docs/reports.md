# Clio Manage reports

Four tools use the official Manage v4 Reports API:

- list_reports: paginated report metadata, with kind/state filters and next_page_token.
- create_report: creates a report job for explicit start_date/end_date; defaults to CSV.
- get_report: checks metadata/status once (no unbounded polling).
- download_report: returns the temporary HTTPS download URL for a completed report.

For revenue, create with kind=revenue, start_date=2026-09-01, end_date=2026-09-18.
For invoice-payment reporting, use kind=invoice_payments_v2. These reports are not
interchangeable with total billed or outstanding balance. Pick the intended
accounting period; report creation timestamps are not payment dates.

Retain the requested period alongside the returned ID; the metadata does not
expose all report parameters. Check get_report with bounded retries while queued
or in_progress. On failed, empty, an unknown state, or a timeout, stop and explain;
do not invent zero revenue or recreate a job automatically. After an uncertain
create response, inspect existing reports before deciding whether to retry.

download_report resolves the official 303 redirect without following it. It does
not download file bytes, save a local file, or calculate totals. Retrieve the
returned URL with a separate unauthenticated download facility. Never attach the
Clio Authorization header, publish the URL, or store it in logs. It may expire;
request a new link through download_report when needed.

create_report is a non-destructive write and is hidden in READ_ONLY mode.
The other three tools remain available. All operations use the current session,
regional API base, existing rate-limit handling, and audit logging. The signed
URL and financial report contents are not written to the audit log.

Access depends on the OAuth app and Clio user's report permissions and product
availability. A 403 is not an empty report: check permissions and reauthorize only
if needed. Do not broadly enable unrelated permissions.

Reference: https://docs.developers.clio.com/clio-manage/api-reference/
OpenAPI: https://docs.developers.clio.com/openapi.json (checked 2026-09-18).

Validation: mocked tests cover schemas, date bounds, association payloads,
pagination, report states, errors, read-only registry behavior and redirect
handling. Live report generation/download with Chase's account remains to be
verified after merge and installation.
