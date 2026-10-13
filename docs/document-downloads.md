# Original template and document-version downloads

- `download_document_template(template_id, output_path?, max_bytes?)`: original stored template, not a generated document.
- `download_document(document_id, document_version_id?, output_path?, max_bytes?)`: latest fully uploaded revision by default, or a numeric version ID from this document's paginated history. A version UUID is not a download selector.

In local **stdio** mode, supply an absolute path in an existing directory. The tool saves privately (0600), never overwrites, checks size and metadata before/after, and returns path, SHA-256 and object/version provenance. No Clio writes. Default limit 50 MiB, configurable up to 512 MiB. Hosted/embedded sessions cannot choose server filesystem paths: omit `output_path` there for a temporary sensitive URL. URL-only results have `downloaded: false`, no hash; the receiving client verifies bytes. A server path is not a staff-computer path.

OAuth goes only to the region-aware Clio endpoint. Storage retrieval has no OAuth headers and refuses further redirects. The current S3 host allowlist fails closed for new providers. Never share/log signed URLs, forward OAuth to storage, or put base64 bytes into a model prompt. Expired URLs require a new read. A 401/403 needs account/scope diagnosis, not a permissions bypass. Existing authenticated-session isolation and Clio restrictions apply; audit records contain IDs/limits only.

## Complex Word briefs

Download the stored template, read authorized matter/contact metadata, compose reviewed document-local arrays in Word, refresh native indexes and inspect pages. Counsel and point counts remain dynamic. Library registration plus acquisition/local composition is **not** successful Clio Document Automation. Simple fixed-structure documents can still use native generation.

Official reference: https://docs.developers.clio.com/clio-manage/api-reference/ (Document Templates download and Documents download, 303 redirect).
