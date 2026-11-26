import { ClientsList } from "@/components/clients/clients-list";
import {
  ClientsViewToggle,
  GroupAccountsList,
} from "@/components/hub/screens/group-accounts-list";
import { getAgentScope } from "@/lib/auth/agent-scope";
import { getClientsRepository } from "@/lib/repositories/clients";
import { getGroupsRepository } from "@/lib/repositories/groups";
import { summarizeClientPolicyProducts } from "@/lib/repositories/policies/client-policy-products";
import { getPoliciesRepository } from "@/lib/repositories/policies";
import { ownerScopedSelect, ownerScopeFilter } from "@/lib/repositories/types";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

type MembershipRow = { client_id: string | null; group_accounts: { id: string; name: string } | null };

/** Clients directory with the Individuals / Group Accounts segments. */
export default async function ClientsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const { view } = await searchParams;
  const ownerUserId = await getAgentScope();

  if (view === "groups") {
    const groups = await getGroupsRepository().list({ ownerUserId });
    return <GroupAccountsList groups={groups} />;
  }

  const [{ rows, total }, archived, memberships] = await Promise.all([
    getClientsRepository().list({ limit: 200, orderBy: "created_at", ascending: false, ownerUserId }),
    getClientsRepository().list({ limit: 200, orderBy: "created_at", ascending: false, includeArchived: true, ownerUserId }),
    ownerScopeFilter(
      getSupabaseAdmin()
        .from("group_members")
        .select(ownerScopedSelect("client_id, group_accounts (id, name)", ownerUserId)),
      ownerUserId,
    )
      .not("client_id", "is", null)
      .limit(1000)
      .returns<MembershipRow[]>(),
  ]);
  const groupsByClient: Record<string, { id: string; name: string }> = {};
  for (const m of memberships.data ?? []) {
    if (m.client_id && m.group_accounts) groupsByClient[m.client_id] = m.group_accounts;
  }
  const archivedClients = archived.rows.filter((c) => c.status === "Archived");
  const clientIds = [...new Set([...rows, ...archivedClients].map((c) => c.id))];
  const policyProductsByClient = summarizeClientPolicyProducts(
    await getPoliciesRepository().listProductsByClientIds(clientIds, { ownerUserId }),
  );

  return (
    <div>
      <ClientsViewToggle view="individuals" />
      <ClientsList
        clients={rows}
        total={total}
        archivedClients={archivedClients}
        groupsByClient={groupsByClient}
        policyProductsByClient={policyProductsByClient}
      />
    </div>
  );
}
