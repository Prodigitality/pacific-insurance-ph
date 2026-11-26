import type { ClientPolicyProduct } from "./policy.entity";

/** Same copy the profile's Policies card uses when a policy has no recorded product. */
export const PRODUCT_NOT_SET = "Product not set";

/**
 * Per client, the distinct product names of that client's policies: newest policy first, case-insensitive
 * de-duplication that keeps the first-seen spelling, and one final "Product not set" when any policy
 * has no recorded product. A client without policies has no entry. Pure and client-safe.
 */
export function summarizeClientPolicyProducts(rows: ClientPolicyProduct[]): Record<string, string[]> {
  const newestFirst = [...rows].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  const names = new Map<string, { seen: Set<string>; ordered: string[]; unset: boolean }>();
  for (const row of newestFirst) {
    const entry = names.get(row.clientId) ?? { seen: new Set<string>(), ordered: [], unset: false };
    names.set(row.clientId, entry);
    const name = row.productName?.trim() ?? "";
    if (!name) { entry.unset = true; continue; }
    const key = name.toLowerCase();
    if (entry.seen.has(key)) continue;
    entry.seen.add(key);
    entry.ordered.push(name);
  }
  const summary: Record<string, string[]> = {};
  for (const [clientId, entry] of names) summary[clientId] = entry.unset ? [...entry.ordered, PRODUCT_NOT_SET] : entry.ordered;
  return summary;
}
