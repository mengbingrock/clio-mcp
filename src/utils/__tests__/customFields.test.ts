import { vi, describe, it, expect, beforeEach } from "vitest";

const { mockClioGetAllPages } = vi.hoisted(() => ({ mockClioGetAllPages: vi.fn() }));
vi.mock("../clioClient.js", () => ({ clioGetAllPages: mockClioGetAllPages }));

import {
  mapCustomFieldValues,
  buildCustomFieldWrites,
  customFieldIdsForAudit,
  hasStrippedCustomFieldValues,
  hasUnresolvedPicklistLabels,
  resolvePicklistLabelsFor,
  CUSTOM_FIELD_VALUE_FIELDS,
} from "../customFields.js";

const PICKLIST = {
  id: "picklist-55003",
  field_name: "Case Type",
  field_type: "picklist",
  value: "9002",
  custom_field: { id: 55003 },
  picklist_option: { id: 9002, option: "Identity Theft" },
};

const TEXT = {
  id: "text_line-55001",
  field_name: "Docket Number",
  field_type: "text_line",
  value: "24-cv-1234",
  custom_field: { id: 55001 },
};

/** A picklist whose selected option came back without its label. */
const PICKLIST_NO_LABEL = {
  id: "picklist-55003",
  field_name: "Case Type",
  field_type: "picklist",
  value: "9002",
  custom_field: { id: 55003 },
};

/** What Clio returns when the expanded attributes are dropped: an id and nothing else. */
const STRIPPED = { id: "picklist-2132716625" };

describe("CUSTOM_FIELD_VALUE_FIELDS", () => {
  it("asks for everything needed to read a field without a second call", () => {
    // Without picklist_option a picklist reads back as a bare option id, and
    // without field_type the caller cannot tell a currency from a text field.
    for (const part of ["field_name", "field_type", "value", "custom_field", "picklist_option"]) {
      expect(CUSTOM_FIELD_VALUE_FIELDS).toContain(part);
    }
  });

  it("never nests a second brace group, which Clio answers with a 400 for the whole request", () => {
    // 2.2.0 shipped `custom_field_values{...,custom_field{id},picklist_option{id,option}}`
    // and Clio replied `picklist_option} is not a valid field`, breaking every
    // matter and contact read for five days. This string is embedded in all of
    // them, so it gets a test rather than a comment.
    const inner = CUSTOM_FIELD_VALUE_FIELDS.slice(
      CUSTOM_FIELD_VALUE_FIELDS.indexOf("{") + 1,
      CUSTOM_FIELD_VALUE_FIELDS.lastIndexOf("}")
    );
    expect(inner).not.toContain("{");
    expect(inner).not.toContain("}");
  });
});

describe("mapCustomFieldValues", () => {
  it("resolves a picklist to its label while keeping the raw option id", () => {
    expect(mapCustomFieldValues([PICKLIST])).toEqual([
      {
        id: "picklist-55003",
        field_id: 55003,
        name: "Case Type",
        type: "picklist",
        value: "9002",
        display_value: "Identity Theft",
      },
    ]);
  });

  it("leaves non-picklist values untouched, display_value included", () => {
    const [mapped] = mapCustomFieldValues([TEXT]);
    expect(mapped.value).toBe("24-cv-1234");
    expect(mapped.display_value).toBe("24-cv-1234");
  });

  it("preserves falsy values rather than coercing them away", () => {
    // A cleared checkbox and a zero-dollar loss are both real answers.
    const [checkbox] = mapCustomFieldValues([
      { id: "checkbox-1", field_name: "Police Report", field_type: "checkbox", value: false, custom_field: { id: 1 } },
    ]);
    expect(checkbox.value).toBe(false);
    expect(checkbox.display_value).toBe(false);
  });

  it("falls back to the nested custom_field name when field_name is absent", () => {
    const [mapped] = mapCustomFieldValues([{ id: "x-1", value: "v", custom_field: { id: 1, name: "Legacy" } }]);
    expect(mapped.name).toBe("Legacy");
  });

  it("returns an empty array for missing or non-array input", () => {
    expect(mapCustomFieldValues(undefined)).toEqual([]);
    expect(mapCustomFieldValues(null)).toEqual([]);
    expect(mapCustomFieldValues({} as unknown)).toEqual([]);
  });
});

describe("buildCustomFieldWrites", () => {
  const existing = mapCustomFieldValues([TEXT, PICKLIST]);

  it("addresses an existing value by its composite id and omits custom_field", () => {
    expect(buildCustomFieldWrites([{ custom_field_id: 55001, value: "24-cv-9999" }], existing)).toEqual([
      { id: "text_line-55001", value: "24-cv-9999" },
    ]);
  });

  it("addresses a field with no value yet by its definition id", () => {
    expect(buildCustomFieldWrites([{ custom_field_id: 99999, value: "new" }], existing)).toEqual([
      { custom_field: { id: 99999 }, value: "new" },
    ]);
  });

  it("picks the right shape per field within one batch", () => {
    const writes = buildCustomFieldWrites(
      [
        { custom_field_id: 55001, value: "a" },
        { custom_field_id: 12345, value: "b" },
      ],
      existing
    );
    expect(writes).toEqual([
      { id: "text_line-55001", value: "a" },
      { custom_field: { id: 12345 }, value: "b" },
    ]);
  });

  it("clears an existing value with _destroy", () => {
    expect(buildCustomFieldWrites([{ custom_field_id: 55003, clear: true }], existing)).toEqual([
      { id: "picklist-55003", _destroy: true },
    ]);
  });

  it("throws rather than no-op when clearing a field that has no value", () => {
    // Clio has nothing to target, so the call would appear to succeed and change
    // nothing. Failing loudly is the only honest outcome.
    expect(() => buildCustomFieldWrites([{ custom_field_id: 404, clear: true }], existing)).toThrow(
      /no value on this record/
    );
  });

  it("throws when neither a value nor clear is given", () => {
    expect(() => buildCustomFieldWrites([{ custom_field_id: 55001 }], existing)).toThrow(/provide a value/);
  });

  it("treats an empty existing set as all-new", () => {
    expect(buildCustomFieldWrites([{ custom_field_id: 55001, value: "x" }], [])).toEqual([
      { custom_field: { id: 55001 }, value: "x" },
    ]);
  });
});

describe("customFieldIdsForAudit", () => {
  it("reduces a write batch to field ids so no value reaches the log", () => {
    const summary = customFieldIdsForAudit([
      { custom_field_id: 55001, value: "Loss of $47,300" },
      { custom_field_id: 55003, value: "9002" },
    ]);
    expect(summary).toEqual([55001, 55003]);
    expect(JSON.stringify(summary)).not.toContain("47,300");
  });

  it("stays undefined when nothing was written", () => {
    expect(customFieldIdsForAudit(undefined)).toBeUndefined();
  });
});


describe("picklist labels", () => {
  it("uses the inline option label when Clio sends one", () => {
    const [field] = mapCustomFieldValues([PICKLIST]);
    expect(field.display_value).toBe("Identity Theft");
    expect(field.label_unresolved).toBeUndefined();
  });

  it("never presents the raw option id as the human reading of a picklist", () => {
    // The whole point. A firm reported exactly this: Claude showing "9002"
    // where the lawyer sees "Identity Theft". Better to show nothing and say so.
    const [field] = mapCustomFieldValues([PICKLIST_NO_LABEL]);
    expect(field.value).toBe("9002");
    expect(field.display_value).toBeNull();
    expect(field.label_unresolved).toBe(true);
  });

  it("treats a value whose type only survives in its composite id as a picklist", () => {
    const [field] = mapCustomFieldValues([{ id: "picklist-1", value: "9002" }]);
    expect(field.display_value).toBeNull();
    expect(field.label_unresolved).toBe(true);
  });

  it("leaves non-picklist fields alone", () => {
    const [field] = mapCustomFieldValues([TEXT]);
    expect(field.display_value).toBe("24-cv-1234");
    expect(field.label_unresolved).toBeUndefined();
  });

  it("does not flag a picklist with nothing selected", () => {
    const [field] = mapCustomFieldValues([{ ...PICKLIST_NO_LABEL, value: null }]);
    expect(field.label_unresolved).toBeUndefined();
  });

  it("resolves from a supplied label map", () => {
    const labels = new Map([["9002", "Identity Theft"]]);
    const [field] = mapCustomFieldValues([PICKLIST_NO_LABEL], labels);
    expect(field.display_value).toBe("Identity Theft");
    expect(field.label_unresolved).toBeUndefined();
  });
});

describe("resolvePicklistLabelsFor", () => {
  const DEFINITIONS = [
    { id: 55003, name: "Case Type", field_type: "picklist", picklist_options: [
      { id: 9001, option: "Credit Reporting" },
      { id: 9002, option: "Identity Theft" },
    ] },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockClioGetAllPages.mockResolvedValue(DEFINITIONS);
  });

  it("makes no request when every label already arrived inline", async () => {
    const groups = [mapCustomFieldValues([PICKLIST, TEXT])];
    await resolvePicklistLabelsFor(groups, "Matter");
    expect(mockClioGetAllPages).not.toHaveBeenCalled();
  });

  it("reads the definitions once for the whole response, not once per record", async () => {
    const groups = [
      mapCustomFieldValues([PICKLIST_NO_LABEL]),
      mapCustomFieldValues([PICKLIST_NO_LABEL]),
      mapCustomFieldValues([PICKLIST_NO_LABEL]),
    ];
    await resolvePicklistLabelsFor(groups, "Matter");

    expect(mockClioGetAllPages).toHaveBeenCalledTimes(1);
    expect(mockClioGetAllPages.mock.calls[0][0]).toBe("/custom_fields.json");
    expect(mockClioGetAllPages.mock.calls[0][1].parent_type).toBe("Matter");
    for (const group of groups) {
      expect(group[0].display_value).toBe("Identity Theft");
      expect(group[0].label_unresolved).toBeUndefined();
    }
  });

  it("leaves the label unresolved when the definitions cannot be read", async () => {
    // The 403 case. A missing label is recoverable; a wrong one on a field a
    // firm vets cases with is not.
    mockClioGetAllPages.mockRejectedValue(new Error("403 forbidden"));
    const groups = [mapCustomFieldValues([PICKLIST_NO_LABEL])];

    await resolvePicklistLabelsFor(groups, "Matter");

    expect(groups[0][0].display_value).toBeNull();
    expect(groups[0][0].label_unresolved).toBe(true);
  });

  it("leaves an option the definitions do not describe unresolved", async () => {
    const groups = [mapCustomFieldValues([{ ...PICKLIST_NO_LABEL, value: "9999" }])];
    await resolvePicklistLabelsFor(groups, "Matter");
    expect(groups[0][0].display_value).toBeNull();
    expect(groups[0][0].label_unresolved).toBe(true);
  });

  it("does not fire for values that were stripped rather than unlabelled", async () => {
    // Stripped values have no option id to look up, and the account that strips
    // them is the account whose /custom_fields.json 403s anyway.
    const groups = [mapCustomFieldValues([STRIPPED])];
    await resolvePicklistLabelsFor(groups, "Matter");
    expect(mockClioGetAllPages).not.toHaveBeenCalled();
  });
});

describe("hasUnresolvedPicklistLabels", () => {
  it("is true only when a set option could not be named", () => {
    expect(hasUnresolvedPicklistLabels([mapCustomFieldValues([PICKLIST_NO_LABEL])])).toBe(true);
    expect(hasUnresolvedPicklistLabels([mapCustomFieldValues([PICKLIST, TEXT])])).toBe(false);
    expect(hasUnresolvedPicklistLabels([[]])).toBe(false);
  });
});

describe("hasStrippedCustomFieldValues", () => {
  it("flags a value that has an id but no name, type or value", () => {
    expect(hasStrippedCustomFieldValues(mapCustomFieldValues([STRIPPED]))).toBe(true);
  });

  it("does not flag normally populated values", () => {
    expect(hasStrippedCustomFieldValues(mapCustomFieldValues([TEXT, PICKLIST]))).toBe(false);
  });

  it("does not flag an empty array", () => {
    expect(hasStrippedCustomFieldValues([])).toBe(false);
  });
});
