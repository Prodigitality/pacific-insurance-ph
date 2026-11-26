import { describe, expect, it } from "vitest";

import { isOutstandingRequirement, medicalReviewBlockers, requirementBlockers } from "./blocked-actions";

const item = (id: string, documentName: string, status: string, isRequired = true, appliesTo: string | null = null) => ({ id, documentName, status, isRequired, appliesTo });

describe("requirementBlockers", () => {
  it("names each outstanding required document and jumps to its row", () => {
    expect(requirementBlockers([
      item("a", "Completed application form", "Pending"),
      item("b", "Valid government-issued ID", "Incomplete"),
    ])).toEqual([
      { label: "Completed application form", target: "requirement-a" },
      { label: "Valid government-issued ID", target: "requirement-b" },
    ]);
  });

  it("skips received and verified items and optional items", () => {
    expect(requirementBlockers([
      item("a", "Completed application form", "Received"),
      item("b", "Valid government-issued ID", "Verified"),
      item("c", "Advisor's Declaration", "Pending", false),
    ])).toEqual([]);
  });

  it("includes an item once it is counted as required", () => {
    const optional = item("c", "Advisor's Declaration", "Pending", false);
    expect(requirementBlockers([optional])).toEqual([]);
    expect(requirementBlockers([{ ...optional, isRequired: true }])).toEqual([{ label: "Advisor's Declaration", target: "requirement-c" }]);
  });

  it("keeps two people's identical documents distinguishable", () => {
    const labels = requirementBlockers([
      item("a", "Valid government-issued ID", "Pending", true, "Ana Cruz"),
      item("b", "Valid government-issued ID", "Pending", true, "Ben Cruz"),
      item("c", "Valid government-issued ID", "Pending", true, "Ana Cruz"),
    ]).map((blocker) => blocker.label);
    expect(labels).toEqual(["Valid government-issued ID · Ana Cruz", "Valid government-issued ID · Ben Cruz", "Valid government-issued ID · Ana Cruz (2)"]);
  });

  it("caps the chips and sends '+N more' to the first remaining row", () => {
    const many = Array.from({ length: 8 }, (_, index) => item(`r${index}`, `Document ${index}`, "Pending"));
    const blockers = requirementBlockers(many);
    expect(blockers).toHaveLength(6);
    expect(blockers.slice(0, 5).map((b) => b.target)).toEqual(["requirement-r0", "requirement-r1", "requirement-r2", "requirement-r3", "requirement-r4"]);
    expect(blockers[5]).toEqual({ label: "+3 more", target: "requirement-r5" });
    expect(requirementBlockers(many.slice(0, 5))).toHaveLength(5);
  });

  it("agrees with the predicate that decides whether a step is blocked", () => {
    const items = [item("a", "A", "Pending"), item("b", "B", "Verified"), item("c", "C", "Incomplete", false), item("d", "D", "Received")];
    expect(requirementBlockers(items).length).toBe(items.filter(isOutstandingRequirement).length);
  });
});

describe("medicalReviewBlockers", () => {
  it("blocks only a pending review", () => {
    for (const status of ["Not required", "Cleared"]) {
      expect(medicalReviewBlockers({ status, canClear: true, blockers: ["x"] })).toEqual([]);
    }
    expect(medicalReviewBlockers({ status: "Pending", canClear: true, blockers: [] })).toEqual([{ label: "Clear the medical review", target: "app-medical-review" }]);
  });

  it("counts evidence still to verify and says who may clear it", () => {
    expect(medicalReviewBlockers({ status: "Pending", canClear: true, blockers: ["one", "two"] })).toEqual([
      { label: "2 medical items to verify", target: "app-medical-review" },
      { label: "Clear the medical review", target: "app-medical-review" },
    ]);
    expect(medicalReviewBlockers({ status: "Pending", canClear: false, blockers: ["one"] })).toEqual([
      { label: "1 medical item to verify", target: "app-medical-review" },
      { label: "Admin or Staff must clear the medical review" },
    ]);
  });
});
