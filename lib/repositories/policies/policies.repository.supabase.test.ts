import { beforeEach, describe, expect, it, vi } from "vitest";

type PolicyFixture = { id: string; client_id: string; created_at: string; product_versions: { product: { name: string } | null } | null };

/** In-memory stand-in for PostgREST: filters, ordering, exact counts and a server-enforced page cap. */
const db = vi.hoisted(() => ({
  policies: [] as PolicyFixture[],
  clientOwners: {} as Record<string, string | null>,
  /** The hosted row cap: a response never carries more rows than this, whatever range was asked for. */
  serverCap: 1000,
  /** Fail any read whose client filter contains this id. */
  failForClient: null as string | null,
  /** Return an empty page for any read after the first (a table that shrank mid-read). */
  emptyAfterFirstPage: false,
  withoutCount: false,
  withoutData: false,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdmin: () => ({
    from: () => {
      let wantsCount = false;
      let owner: string | null = null;
      let clientIds: string[] = [];
      let range: [number, number] = [0, 999];
      const builder = {
        select: (_columns: string, options?: { count?: string }) => { wantsCount = options?.count === "exact"; return builder; },
        eq: (column: string, value: string) => { if (column === "owner_scope.assigned_user_id") owner = value; return builder; },
        in: (_column: string, values: string[]) => { clientIds = values; return builder; },
        order: () => builder,
        range: (from: number, to: number) => { range = [from, to]; return builder; },
        returns: () => builder,
        then: (resolve: (value: unknown) => void) => {
          if (db.failForClient && clientIds.includes(db.failForClient)) return resolve({ data: null, error: { message: "boom", code: "XX000" }, count: null });
          const matching = db.policies
            .filter((p) => clientIds.includes(p.client_id) && (owner === null || db.clientOwners[p.client_id] === owner))
            .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.id.localeCompare(b.id)));
          const [from, to] = range;
          if (db.emptyAfterFirstPage && from > 0) return resolve({ data: [], error: null, count: null });
          const data = db.withoutData ? null : matching.slice(from, Math.min(to + 1, from + db.serverCap));
          resolve({ data, error: null, count: wantsCount && !db.withoutCount ? matching.length : null });
        },
      };
      return builder;
    },
  }),
}));

import { SupabasePoliciesRepository } from "./policies.repository.supabase";
import { summarizeClientPolicyProducts } from "./client-policy-products";

const repo = new SupabasePoliciesRepository();
let seq = 0;
const policy = (clientId: string, name: string | null, createdAt?: string): PolicyFixture => {
  seq += 1;
  return {
    id: `policy-${String(seq).padStart(6, "0")}`,
    client_id: clientId,
    created_at: createdAt ?? new Date(Date.UTC(2026, 0, 1) + seq * 60_000).toISOString(),
    product_versions: name === null ? null : { product: { name } },
  };
};

beforeEach(() => {
  seq = 0;
  db.policies = [];
  db.clientOwners = {};
  db.serverCap = 1000;
  db.failForClient = null;
  db.emptyAfterFirstPage = false;
  db.withoutCount = false;
  db.withoutData = false;
});

describe("listProductsByClientIds", () => {
  it("returns an empty list for no clients", async () => {
    db.policies = [policy("c1", "Select")];
    expect(await repo.listProductsByClientIds([])).toEqual([]);
  });

  it("maps each client's policies of every product, keeping an unset product null", async () => {
    db.policies = [policy("c1", "Select"), policy("c1", "Blue Royale"), policy("c2", null), policy("c3", "Travel")];
    const summary = summarizeClientPolicyProducts(await repo.listProductsByClientIds(["c1", "c2"]));
    expect(summary).toEqual({ c1: ["Blue Royale", "Select"], c2: ["Product not set"] });
  });

  it("reads each duplicated client id once", async () => {
    db.policies = [policy("c1", "Select")];
    const rows = await repo.listProductsByClientIds(["c1", "c1", "c1"]);
    expect(rows).toHaveLength(1);
  });

  it("reads every client across more than one chunk of ids", async () => {
    const ids = Array.from({ length: 250 }, (_, index) => `client-${index}`);
    db.policies = ids.map((id) => policy(id, "Select"));
    const rows = await repo.listProductsByClientIds(ids);
    expect(new Set(rows.map((r) => r.clientId))).toEqual(new Set(ids));
    expect(rows).toHaveLength(250);
  });

  it("does not truncate a client with more than 200 policies", async () => {
    db.policies = Array.from({ length: 450 }, (_, index) => policy("busy", index === 449 ? "Travel" : "Select"));
    const rows = await repo.listProductsByClientIds(["busy"]);
    expect(rows).toHaveLength(450);
    // The 450th (newest) policy is past the second page boundary and still arrives.
    expect(summarizeClientPolicyProducts(rows).busy).toEqual(["Travel", "Select"]);
  });

  it("keeps paging when the server returns fewer rows than the page asked for", async () => {
    db.serverCap = 70;
    db.policies = Array.from({ length: 450 }, () => policy("busy", "Select"));
    db.policies.push(policy("busy", "Blue Royale", "2020-01-01T00:00:00Z"));
    const rows = await repo.listProductsByClientIds(["busy"]);
    expect(rows).toHaveLength(451);
    expect(summarizeClientPolicyProducts(rows).busy).toEqual(["Select", "Blue Royale"]);
  });

  it("scopes to the agent's own clients even when a foreign client id is supplied", async () => {
    db.clientOwners = { mine: "agent-1", theirs: "agent-2" };
    db.policies = [policy("mine", "Select"), policy("theirs", "Blue Royale")];
    const rows = await repo.listProductsByClientIds(["mine", "theirs"], { ownerUserId: "agent-1" });
    expect(rows.map((r) => r.clientId)).toEqual(["mine"]);
    const everyone = await repo.listProductsByClientIds(["mine", "theirs"], { ownerUserId: null });
    expect(everyone.map((r) => r.clientId).sort()).toEqual(["mine", "theirs"]);
  });
});

describe("listProductsByClientIds failures never become partial results", () => {
  it("rejects on a database error", async () => {
    db.policies = [policy("c1", "Select")];
    db.failForClient = "c1";
    await expect(repo.listProductsByClientIds(["c1"])).rejects.toThrow("PoliciesRepository.listProductsByClientIds: boom");
  });

  it("rejects the whole read when only one chunk fails", async () => {
    const ids = Array.from({ length: 150 }, (_, index) => `client-${index}`);
    db.policies = ids.map((id) => policy(id, "Select"));
    db.failForClient = "client-149";
    await expect(repo.listProductsByClientIds(ids)).rejects.toThrow("boom");
  });

  it("rejects when the exact count is missing", async () => {
    db.policies = [policy("c1", "Select")];
    db.withoutCount = true;
    await expect(repo.listProductsByClientIds(["c1"])).rejects.toThrow("policy products could not be loaded completely.");
  });

  it("rejects when no data is returned", async () => {
    db.policies = [policy("c1", "Select")];
    db.withoutData = true;
    await expect(repo.listProductsByClientIds(["c1"])).rejects.toThrow("policy products could not be loaded completely.");
  });

  it("rejects when a page comes back empty while rows remain outstanding", async () => {
    db.serverCap = 100;
    db.emptyAfterFirstPage = true;
    db.policies = Array.from({ length: 300 }, () => policy("busy", "Select"));
    await expect(repo.listProductsByClientIds(["busy"])).rejects.toThrow("policy products could not be loaded completely.");
  });
});
