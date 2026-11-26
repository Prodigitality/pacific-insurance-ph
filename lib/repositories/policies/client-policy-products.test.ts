import { describe, expect, it } from "vitest";

import { summarizeClientPolicyProducts } from "./client-policy-products";
import type { ClientPolicyProduct } from "./policy.entity";

const row = (clientId: string, productName: string | null, createdAt = "2026-01-01T00:00:00Z"): ClientPolicyProduct => ({ clientId, productName, createdAt });

describe("summarizeClientPolicyProducts", () => {
  it("lists every distinct product of a client, newest policy first", () => {
    const summary = summarizeClientPolicyProducts([
      row("c1", "Select", "2026-01-01T00:00:00Z"),
      row("c1", "Blue Royale", "2026-06-01T00:00:00Z"),
    ]);
    expect(summary).toEqual({ c1: ["Blue Royale", "Select"] });
  });

  it("collapses repeated products case-insensitively, keeping the newest spelling", () => {
    const summary = summarizeClientPolicyProducts([
      row("c1", "select ", "2026-01-01T00:00:00Z"),
      row("c1", "Select", "2026-03-01T00:00:00Z"),
      row("c1", "SELECT", "2026-02-01T00:00:00Z"),
    ]);
    expect(summary).toEqual({ c1: ["Select"] });
  });

  it("shows Product not set once, after the real products, for missing or blank names", () => {
    const summary = summarizeClientPolicyProducts([
      row("c1", null, "2026-09-01T00:00:00Z"),
      row("c1", "Select", "2026-05-01T00:00:00Z"),
      row("c1", "   ", "2026-04-01T00:00:00Z"),
    ]);
    expect(summary).toEqual({ c1: ["Select", "Product not set"] });
    expect(summarizeClientPolicyProducts([row("c2", null)])).toEqual({ c2: ["Product not set"] });
  });

  it("keeps clients isolated and gives a client without policies no entry", () => {
    const summary = summarizeClientPolicyProducts([row("c1", "Select"), row("c2", "Blue Royale"), row("c2", "Travel")]);
    expect(summary.c1).toEqual(["Select"]);
    expect(summary.c2).toEqual(["Blue Royale", "Travel"]);
    expect(Object.keys(summary).sort()).toEqual(["c1", "c2"]);
    expect(summary.c3).toBeUndefined();
    expect(summarizeClientPolicyProducts([])).toEqual({});
  });
});
