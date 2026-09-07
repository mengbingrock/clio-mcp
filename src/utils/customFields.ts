/**
 * Clio custom field values: read mapping, write mapping, and audit-safe summaries.
 *
 * Three Clio behaviours drive everything in this file.
 *
 * 1. THE `fields` PARAMETER. `custom_field_values` is itself a nested resource on
 *    matters and contacts, and Clio's parser does not accept a further brace
 *    group inside it: asking for
 *    `custom_field_values{...,custom_field{id},picklist_option{id,option}}`
 *    is answered with `400 ... picklist_option} is not a valid field`, which
 *    took out every matter and contact read in 2.2.0. `custom_field` and
 *    `picklist_option` are therefore listed bare and come back with whatever
 *    Clio's default attributes for each are.
 *
 * 2. READ. A custom field value's `value` is type-dependent, and for `picklist`
 *    fields it is the selected option's *id*, not its label (e.g. "9002"). We do
 *    not assume the bare `picklist_option` association carries the label, because
 *    we cannot verify it: if it does, the label is used; if it does not,
 *    `display_value` is null and `label_unresolved` is set, and the caller can
 *    fill the gap from the field definitions with `resolvePicklistLabelsFor`.
 *    What must never happen is a raw option id being presented as the human
 *    reading of the field, which is the bug a firm reported in 2.1.
 *
 * 3. WRITE. Setting a field that has no value yet and changing one that already
 *    does use *different* shapes. New value: `{custom_field: {id}, value}`.
 *    Existing value: `{id: "<composite>", value}` where the id is the value
 *    instance's own composite string id (e.g. "text_line-55001") and
 *    `custom_field` is omitted. Clearing: `{id: "<composite>", _destroy: true}`.
 *    Clio does not document what happens when the new-value shape is sent for a
 *    field that already has one, so `buildCustomFieldWrites` never guesses: the
 *    caller reads the record first and passes what is already there.
 */
import { clioGetAllPages } from "./clioClient.js";

/**
 * The `fields=` sub-selection needed to read custom fields usefully.
 *
 * Nothing here may contain a `{`. See note 1 above; `customFields.test.ts`
 * enforces it, because getting this wrong breaks every matter and contact read
 * at once rather than degrading one column.
 */
export const CUSTOM_FIELD_VALUE_FIELDS =
  "custom_field_values{id,field_name,field_type,value,custom_field,picklist_option}";

/** The `fields=` selection for custom field *definitions* at /custom_fields.json. */
export const CUSTOM_FIELD_DEFINITION_FIELDS =
  "id,name,field_type,parent_type,required,displayed,deleted,picklist_options{id,option}";

/**
 * What Clio says when a custom field read is refused, and what we actually know
 * about why. Deliberately does not name a settings screen: the two candidate
 * causes point at different places, and neither has been reproduced by us.
 */
export const CUSTOM_FIELD_PERMISSION_HINT =
  "Clio refused a custom field read with 403 \"User is forbidden from taking that action\". " +
  "When this happens, /custom_fields.json returns 403 and the custom field values expanded on " +
  "matters and contacts come back with an id but no name, type or value and no error at all. " +
  "The cause is not confirmed. It is consistent with the connecting Clio user's permission set " +
  "not covering custom fields, but it has also been reported on an account owner's own token, " +
  "which that explanation does not fit. Ask a Clio administrator to confirm the connecting user " +
  "has custom field access; if that is already true, please open an issue at " +
  "https://github.com/oktopeak/clio-mcp/issues with your region and the exact response, because " +
  "we have not been able to reproduce it.";

/** Shorter form, embedded in a successful response whose values came back stripped. */
export const CUSTOM_FIELD_STRIPPED_WARNING =
  "Some custom field values came back with an id but no name, type or value. Clio does this " +
  "silently, and the same accounts get a 403 from list_custom_fields. The cause is not yet " +
  "confirmed - see Troubleshooting in the README. Treat these fields as unread, not as empty.";

export interface MappedCustomField {
  /** Composite value-instance id, e.g. "text_line-55001". Needed to update or clear this value. */
  id: string | null;
  /** The field *definition* id (a plain integer). Stable across records. */
  field_id: number | null;
  name: string | null;
  type: string | null;
  /** Raw value exactly as Clio returned it. For picklists this is the option id. */
  value: unknown;
  /** Human-readable value. Identical to `value` except for picklists, where it is the option label. */
  display_value: unknown;
  /**
   * Set only on a picklist whose option label could not be resolved. Its
   * `display_value` is null rather than the option id, so a caller never mistakes
   * an internal id for the selection a lawyer sees in Clio.
   */
  label_unresolved?: true;
}

/** Picklist option id (as a string) -> the option's label. */
export type PicklistLabelMap = ReadonlyMap<string, string>;

/**
 * Clio's composite value id encodes the field type ("picklist-2132716625"), which
 * is the only type signal left when the expanded attributes come back stripped.
 * Used for the picklist decision only; the reported `type` stays exactly what
 * Clio sent, so `hasStrippedCustomFieldValues` can still tell stripped from set.
 */
function typeFromCompositeId(id: unknown): string | null {
  if (typeof id !== "string") return null;
  const dash = id.lastIndexOf("-");
  return dash > 0 ? id.slice(0, dash) : null;
}

function labelFromInlineOption(v: any): string | undefined {
  const option = v?.picklist_option?.option;
  return typeof option === "string" && option.length > 0 ? option : undefined;
}

/**
 * Normalises Clio's `custom_field_values` array into a flat, name-first shape.
 * Returns [] for a missing or non-array input so callers never branch on it.
 *
 * `labels` is optional and only consulted for picklists whose label did not
 * arrive inline. See `resolvePicklistLabelsFor`.
 */
export function mapCustomFieldValues(raw: unknown, labels?: PicklistLabelMap): MappedCustomField[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((v: any) => {
    const type = v?.field_type ?? null;
    const value = v?.value ?? null;
    const isPicklist = (type ?? typeFromCompositeId(v?.id)) === "picklist";

    let display_value: unknown = value;
    let label_unresolved = false;
    if (isPicklist) {
      const label = labelFromInlineOption(v) ?? (value != null ? labels?.get(String(value)) : undefined);
      display_value = label ?? null;
      // A picklist with no value selected is resolved, not unresolved: there is
      // no label to find. Only a set option we could not name is a gap.
      label_unresolved = label === undefined && value != null;
    }

    return {
      id: v?.id ?? null,
      field_id: v?.custom_field?.id ?? null,
      name: v?.field_name ?? v?.custom_field?.name ?? null,
      type,
      value,
      display_value,
      ...(label_unresolved && { label_unresolved: true as const }),
    };
  });
}

/** True if any mapped picklist is missing its label and could be filled in from the definitions. */
export function hasUnresolvedPicklistLabels(groups: readonly MappedCustomField[][]): boolean {
  return groups.some((g) => g.some((f) => f.label_unresolved === true));
}

/**
 * Fills in picklist labels that did not arrive inline, in place.
 *
 * Costs one read of the field definitions, and only on a response that actually
 * needs it: when Clio's bare `picklist_option` association carries the label,
 * this never makes a request at all. A failure (the 403 above is the expected
 * one) leaves the labels unresolved rather than guessing, because a wrong label
 * on a case-vetting field is worse than a missing one.
 *
 * Deliberately not cached across calls: the HTTP transport is multi-tenant, and
 * a process-wide picklist map would put one firm's field labels into another
 * firm's response.
 */
export async function resolvePicklistLabelsFor(
  groups: MappedCustomField[][],
  parentType: "Matter" | "Contact"
): Promise<void> {
  if (!hasUnresolvedPicklistLabels(groups)) return;

  let labels: PicklistLabelMap;
  try {
    labels = await fetchPicklistLabels(parentType);
  } catch {
    return;
  }
  if (labels.size === 0) return;

  for (const group of groups) {
    for (const field of group) {
      if (field.label_unresolved !== true || field.value == null) continue;
      const label = labels.get(String(field.value));
      if (label === undefined) continue;
      field.display_value = label;
      delete field.label_unresolved;
    }
  }
}

async function fetchPicklistLabels(parentType: "Matter" | "Contact"): Promise<PicklistLabelMap> {
  const definitions = await clioGetAllPages("/custom_fields.json", {
    fields: CUSTOM_FIELD_DEFINITION_FIELDS,
    parent_type: parentType,
  });
  const labels = new Map<string, string>();
  for (const def of definitions) {
    for (const option of def?.picklist_options ?? []) {
      if (option?.id != null && typeof option?.option === "string") {
        labels.set(String(option.id), option.option);
      }
    }
  }
  return labels;
}

/**
 * True if any mapped value looks permission-stripped: Clio returned a composite
 * id but null name, type and value. A field that simply has no value set does
 * not appear in `custom_field_values` at all, so this shape means the attributes
 * were dropped rather than the field being empty.
 */
export function hasStrippedCustomFieldValues(mapped: MappedCustomField[]): boolean {
  return mapped.some((m) => m.id !== null && m.name === null && m.type === null && m.value === null);
}

/** One custom field write as the caller expresses it, before Clio's shape rules are applied. */
export interface CustomFieldWriteInput {
  custom_field_id: number;
  value?: string | number | boolean;
  /** Clear this field's value instead of setting it. Requires an existing value. */
  clear?: boolean;
}

/**
 * Turns caller intent plus the record's current values into Clio's write payload.
 *
 * `existing` is the record's `custom_field_values` as returned by Clio (raw or
 * already mapped). Fields found there are updated in place by composite id;
 * fields not found are created with `custom_field: {id}`.
 *
 * Throws when asked to clear a field that has no value, because Clio has no
 * composite id to target and would silently do nothing.
 */
export function buildCustomFieldWrites(
  inputs: CustomFieldWriteInput[],
  existing: MappedCustomField[]
): Record<string, unknown>[] {
  const byFieldId = new Map<number, MappedCustomField>();
  for (const e of existing) {
    if (e.field_id !== null && e.id !== null) byFieldId.set(e.field_id, e);
  }

  return inputs.map((input) => {
    const current = byFieldId.get(input.custom_field_id);

    if (input.clear) {
      if (!current) {
        throw new Error(
          `Cannot clear custom field ${input.custom_field_id}: it has no value on this record.`
        );
      }
      return { id: current.id, _destroy: true };
    }

    if (input.value === undefined) {
      throw new Error(
        `Custom field ${input.custom_field_id}: provide a value, or set clear: true to remove it.`
      );
    }

    // Existing value: address it by its own composite id and omit custom_field.
    if (current) return { id: current.id, value: input.value };

    // No value yet: address the field definition.
    return { custom_field: { id: input.custom_field_id }, value: input.value };
  });
}

/**
 * Audit-safe summary of a custom field write: which fields were touched, never
 * what they were set to. Custom fields are where firms keep case-vetting data
 * (loss amounts, incident dates, names), so values must not reach the log.
 */
export function customFieldIdsForAudit(inputs?: CustomFieldWriteInput[]): number[] | undefined {
  if (!inputs) return undefined;
  return inputs.map((i) => i.custom_field_id);
}
