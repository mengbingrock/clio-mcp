# Clio Manage document templates

These tools wrap the [official Clio Manage v4 API](https://docs.developers.clio.com/clio-manage/api-reference/), not Clio Draft or Carbone.

| Tool | Endpoint |
| --- | --- |
| list_document_templates | GET /document_templates.json |
| get_document_template | GET /document_templates/{id}.json |
| create_document_template | POST /document_templates.json |
| update_document_template | PATCH /document_templates/{id}.json |
| delete_document_template | DELETE /document_templates/{id}.json |
| list_document_automations | GET /document_automations.json |
| create_document_automation | POST /document_automations.json |
| get_document_automation | GET /document_automations/{id}.json |

## Workflow

1. List templates, following `next_page_token` until `has_more` is false, and read the selected template's metadata.
2. If authorized to create a template, supply raw padded `file_base64`, `filename`, and optionally `document_category_id`. The connector caps base64 input at 28 MiB (a local safety bound, not a claimed Clio limit). Use Clio merge fields, not Carbone placeholders.
3. Generate with `template_id`, `matter_id`, `filename` and `formats: ["original"]`, `["pdf"]`, or both. Merge values come from Clio matter-related data; this endpoint does not accept arbitrary JSON field values.
4. Save the returned automation ID. Query `get_document_automation` for state and `documents` IDs. Submission is not completion. Use existing `get_document` for each generated document's metadata/download URL, and verify content and formatting.
5. On a timeout, inspect generation jobs before resubmitting. Creation is not idempotent. Update replaces the specified template fields; read first and coordinate concurrent edits. Deletion requires `confirm: true`.

Read-only mode hides all four write tools. The same registry supports stdio, HTTP and library consumers. Existing session authentication and region routing apply. The tools do not grant permissions: Clio account access, app scopes and subscription availability must be checked during deployment; a 403 is not evidence the API is missing. Reauthorization may be needed after app scope changes.

Template file contents and filenames are excluded from these tools' audit entries. Template contents download, category management, conditional Clio Draft authoring, and automatic Carbone conversion are not part of this change.

## Verification

Unit tests use mocked Clio responses and cover request contracts, response fields, pagination, validation, errors, privacy, and non-retry of uncertain submissions. Registry tests cover read-only filtering. No production templates or documents are created by tests. Live upload/generation and account permissions still require an authorized test matter/template and visual inspection of the resulting document.
