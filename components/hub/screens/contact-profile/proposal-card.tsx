"use client";

import Image from "next/image";
import Link from "next/link";
import { useOptimistic, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import {
  deleteProposalPdfAction,
  replaceProposalPdfAction,
  setProposalStatusAction,
  type UploadedProposal,
} from "@/app/(app)/prospects/actions";
import { PdfUpload } from "@/components/documents/pdf-upload";
import type { Client } from "@/lib/repositories/clients/client.entity";
import { cn } from "@/lib/utils";
import { I } from "../../icons";
import { isIndividualProposalProduct, isProposalAccepted, proposalStatusLine } from "../../lead-config";
import { ProposalReceiptUpload, ProposalUploadedNotice } from "../../overlays/generate-proposal";
import { useOverlays } from "../../overlays/overlay-provider";
import { openPortalWindow } from "../../overlays/portal-window";
import { Btn, Card, CardHead, TONE_TEXT } from "../../primitives";
import type { Tone } from "../../tone";
import type { Doc } from "./records-cards";

/** A text action docked beside the proposal PDF link. */
const FILE_ACTION =
  "shrink-0 border-l border-border-soft px-3 text-[12px] font-semibold text-muted-foreground transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/30 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-muted-foreground";

/**
 * Lead-only proposal tracking card. Actions follow `proposal_status`, not `lead_stage`: Generate
 * Proposal is offered at every stage (header menu), so a Requested/Received proposal on a
 * Product Selected lead must still be trackable here.
 */
export function ProposalCard({
  client,
  pacificCrossPortalUrl,
  proposalDocument,
  onGenerate,
  onRequest,
  onEmailProposal,
  onRecordDecision,
  onStatusChange,
  canDeleteProposal,
}: {
  client: Client;
  pacificCrossPortalUrl: string | null;
  /** Most recent uploaded illustrative proposal, if any. */
  proposalDocument: Doc | null;
  onGenerate: () => void;
  onRequest: () => void;
  /** Open the proposal-delivery email with the current proposal attached, for review + Send. */
  onEmailProposal: () => void;
  onRecordDecision: () => void;
  onStatusChange: (proposalStatus: string) => void;
  /**
   * Whether the real signed-in user is an Admin/Owner (never the View-as preview). Gates the
   * destructive Delete; the server action and SQL recheck it.
   */
  canDeleteProposal: boolean;
}) {
  const router = useRouter();
  const overlays = useOverlays();
  const [pending, startTransition] = useTransition();
  const [proposalMarking, setProposalMarking] = useState<string | null>(null);
  const [status, setOptimisticStatus] = useOptimistic(client.proposalStatus);
  const [replacing, setReplacing] = useState(false);
  const [uploaded, setUploaded] = useState<{
    proposal: UploadedProposal;
    heading: string;
    base: Doc | null;
    confirming: boolean;
  } | null>(null);
  // Our upload stands in for the stale `proposalDocument` prop until the refresh swaps it.
  const shownDocument = uploaded && uploaded.base === proposalDocument ? uploaded.proposal : proposalDocument;
  // Covers the open confirmation and the server round trip, so nothing else can act on the PDF.
  const [deletePending, startDelete] = useTransition();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const deleteRequested = useRef(false);
  const deleting = confirmingDelete || deletePending;
  const busy = pending || deleting;

  const deleteProposal = async (documentId: string) => {
    if (deleteRequested.current) return;
    deleteRequested.current = true;
    setConfirmingDelete(true);
    const confirmed = await overlays.confirm({
      kind: "danger",
      title: "Delete proposal?",
      message: "The current proposal will be removed and proposal tracking will return to Requested. An Inbox original will be retained.",
      confirmLabel: "Delete proposal",
    });
    setConfirmingDelete(false);
    if (!confirmed) {
      deleteRequested.current = false;
      return;
    }
    startDelete(async () => {
      // `removed`: the record is gone, even if its file cleanup failed. `unknown`: the request
      // itself failed, so the server may still have committed. Either way our upload stand-in
      // must go: with no proposal left, `uploaded.base` would match the refreshed prop again.
      let outcome: "removed" | "failed" | "unknown" = "unknown";
      try {
        const res = await deleteProposalPdfAction(client.id, documentId);
        if (res.ok) {
          outcome = "removed";
          overlays.toast(
            res.data.originalPreserved ? "Proposal PDF unlinked" : "Proposal PDF deleted",
            res.data.originalPreserved
              ? `${client.fullName}: proposal tracking is back to Requested. The Inbox original stays in Documents.`
              : `${client.fullName}: proposal tracking is back to Requested.`,
          );
        } else if ("recordRemoved" in res && res.recordRemoved) {
          outcome = "removed";
          overlays.toast("Proposal file not fully removed", res.error);
        } else {
          outcome = "failed";
          overlays.toast("Couldn’t delete proposal", res.error);
        }
      } catch {
        overlays.toast("Couldn’t delete proposal", "The request didn’t complete. Refresh the record to see its current state.");
      }
      deleteRequested.current = false;
      // Local cleanup commits together with the refreshed server props.
      startDelete(() => {
        if (outcome !== "failed") {
          setUploaded(null);
          setReplacing(false);
        }
        if (outcome === "removed") onStatusChange("Requested");
        router.refresh();
      });
    });
  };

  const markProposal = (next: string) => {
    setProposalMarking(next);
    startTransition(async () => {
      setOptimisticStatus(next);
      const res = await setProposalStatusAction(client.id, next);
      if (res.ok) {
        onStatusChange(next);
        overlays.toast(`Proposal ${next.toLowerCase()}`, `${client.fullName} — proposal marked ${next}.`);
      } else overlays.toast("Couldn’t update proposal", res.error);
      router.refresh();
    });
  };

  const showUploaded = (proposal: UploadedProposal, heading: string) =>
    setUploaded({ proposal, heading, base: proposalDocument, confirming: true });

  const STEPS = ["Requested", "Received", "Sent", "Decision"];
  // Advancing past Proposal is the acceptance, so the tracker completes and stops asking for a decision.
  const accepted = isProposalAccepted(status, client.proposalDecision, client.leadStage);
  const stepIndex = accepted ? STEPS.length : STEPS.indexOf(status ?? "");
  const individual = isIndividualProposalProduct(client.productInterest);
  const stepBar = (
    <div className="flex items-center gap-1.5" aria-label={`Proposal ${accepted ? "accepted" : status ?? "not started"}`}>
      {STEPS.map((s, i) => (
        <span key={s} title={s} className={cn("h-1.5 flex-1 rounded-full", stepIndex >= 0 && i < stepIndex ? "bg-brand" : stepIndex === i ? "bg-violet" : "bg-surface-3")} />
      ))}
    </div>
  );
  const statusText = status
    ? proposalStatusLine(status, status === "Decision" ? client.proposalDecision : null, client.productInterest, accepted)
    : `No proposal ${individual ? "generated" : "requested"} yet.`;
  // The shared line reads "<state> — <product> quote."; the card shows the state in its tone, then the quote.
  const [statusHead, statusDetail] = (() => {
    const [head, ...rest] = statusText.split(" — ");
    return [head.replace(/\.$/, ""), rest.length ? rest.join(" — ").replace(/\.$/, "") : null] as const;
  })();
  const statusTone: Tone = !status ? "slate"
    : client.proposalDecision === "Declined" && status === "Decision" ? "red"
      : accepted ? "green" : status === "Received" ? "blue" : "violet";
  const portalSettingsLink = !pacificCrossPortalUrl && individual ? (
    <Link href="/settings" className="inline-flex h-8 items-center gap-1.5 rounded-md border border-amber-border bg-amber-soft px-3 text-[12.5px] font-semibold text-amber transition-colors hover:bg-hover">
      <I.settings size={14} /> Configure portal in Settings
    </Link>
  ) : null;
  const markSent = () => markProposal("Sent");
  const markingSent = pending && proposalMarking === "Sent";
  const recipient = client.email;
  const otherActions = [
    client.leadStage === "Proposal" && !status && (
      <Btn key="start" size="sm" onClick={() => (individual ? onGenerate() : onRequest())}>{individual ? "Generate proposal" : "Request proposal"}</Btn>
    ),
    status === "Requested" && (
      <Btn key="received" size="sm" disabled={busy} onClick={() => markProposal("Received")}>
        {pending && proposalMarking === "Received" ? "Marking received…" : "Mark Received without PDF"}
      </Btn>
    ),
    !accepted && status === "Sent" && <Btn key="decide" size="sm" disabled={deleting} onClick={onRecordDecision}>Record decision</Btn>,
    !accepted && status === "Decision" && <Btn key="update" size="sm" disabled={deleting} onClick={onRecordDecision}>Update decision</Btn>,
  ].filter(Boolean);
  const receiptUpload = (!status || status === "Requested") && !uploaded?.confirming ? (
    <ProposalReceiptUpload
      clientId={client.id}
      defaultFrequency={client.paymentFrequency}
      prompt="Upload proposal"
      onUploaded={(proposal) => {
        showUploaded(proposal, "Proposal attached and marked Received");
        onStatusChange("Received");
        overlays.toast("Proposal received", `${client.fullName}: PDF attached and marked Received.`);
        router.refresh();
      }}
    />
  ) : null;
  const uploadedNotice = uploaded?.confirming ? (
    <ProposalUploadedNotice proposal={uploaded.proposal} heading={uploaded.heading} onDone={() => setUploaded({ ...uploaded, confirming: false })} />
  ) : null;
  const hasFiledProposal = !uploaded?.confirming && !!shownDocument && !!status && status !== "Requested";
  const documentRow = hasFiledProposal && shownDocument ? (
    <div className="flex items-stretch overflow-hidden rounded-md border border-border-soft">
      <a
        href={`/api/documents/${shownDocument.id}/download`}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Open ${shownDocument.name} in a new tab`}
        className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-[12.5px] font-semibold text-brand-hover transition-colors hover:bg-hover"
      >
        <I.fileText size={15} className="shrink-0" />
        <span className="truncate">{shownDocument.name}</span>
      </a>
      {!replacing && (
        <button type="button" disabled={busy} onClick={() => setReplacing(true)} className={cn(FILE_ACTION, "hover:text-foreground")}>
          Replace
        </button>
      )}
      {!replacing && canDeleteProposal && (
        <button
          type="button"
          disabled={busy}
          aria-label={`Delete ${shownDocument.name}`}
          onClick={() => void deleteProposal(shownDocument.id)}
          className={cn(FILE_ACTION, "hover:text-red")}
        >
          {deletePending ? "Deleting…" : "Delete"}
        </button>
      )}
    </div>
  ) : null;
  const replaceUpload = replacing && hasFiledProposal ? (
    <div>
      <PdfUpload
        clientId={client.id}
        prompt="Upload the corrected PDF; the current one is kept as Replaced"
        onUploaded={async (path, fileName) => {
          const res = await replaceProposalPdfAction(client.id, path, fileName);
          if (res.ok) {
            setReplacing(false);
            showUploaded(res.data, "Proposal PDF replaced");
            overlays.toast("Proposal PDF replaced", `${client.fullName}: the previous PDF is kept as Replaced.`);
            router.refresh();
          }
          return res;
        }}
      />
      <div className="mt-1.5 flex justify-end">
        <Btn size="sm" variant="ghost" onClick={() => setReplacing(false)}>Cancel</Btn>
      </div>
    </div>
  ) : null;
  // The quote recorded at upload, shown as label / value rows under the PDF.
  const noteParts = hasFiledProposal && shownDocument === proposalDocument && proposalDocument?.notes ? proposalDocument.notes.split(" · ") : [];
  const details = [
    { label: "Payment", value: noteParts.find((p) => p === "Annual" || p === "Semi-annual") },
    { label: "Grand total", value: noteParts.find((p) => p.startsWith("Grand total "))?.replace("Grand total ", "") },
    { label: "Quotation", value: noteParts.find((p) => p.startsWith("Quotation "))?.replace("Quotation ", "") },
  ].filter((d): d is { label: string; value: string } => !!d.value);

  return (
    <Card>
      <CardHead iconName="fileText" title="Proposal tracking" />
      <div className="flex flex-col gap-3.5 px-[18px] py-3.5">
        <div className="flex items-start justify-between gap-3">
          <p className="min-w-0 self-center text-[14.5px] font-semibold leading-snug text-foreground">
            <span className={TONE_TEXT[statusTone]}>{statusHead}</span>
            {statusDetail && <span className="font-medium text-muted-foreground"> · {statusDetail}</span>}
          </p>
          {pacificCrossPortalUrl && (
            <button type="button" onClick={() => openPortalWindow(pacificCrossPortalUrl)} title="Open Pacific Cross portal" aria-label="Open Pacific Cross portal"
              className="relative grid size-16 shrink-0 place-items-center content-center gap-1 rounded-md border border-border-strong bg-card text-[11px] font-semibold text-muted-foreground shadow-xs transition-colors hover:border-faint hover:bg-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30">
              <Image src="/pacific-cross-logo.png" alt="" width={30} height={30} className="size-[30px] rounded-[5px]" />
              Portal
              <I.arrowUpRight size={11} className="absolute right-1 top-1 text-subtle" />
            </button>
          )}
        </div>
        {stepBar}
        {portalSettingsLink}
        {status === "Received" && !accepted && (
          <div className="rounded-md border border-border-soft bg-surface-2 p-3">
            <p className="truncate text-[11.5px] text-muted-foreground" title={recipient ?? undefined}>
              Send to <span className="font-medium text-foreground">{recipient ?? "no email on file"}</span>
            </p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <Btn size="sm" variant="primary" disabled={deleting} onClick={onEmailProposal}>Email</Btn>
              <Btn size="sm" disabled={busy} onClick={markSent} title="Record a proposal you sent outside the CRM. This is not Gmail evidence.">
                {markingSent ? "Marking…" : "Mark sent"}
              </Btn>
            </div>
          </div>
        )}
        {status !== "Requested" && otherActions.length > 0 && <div className="flex flex-wrap gap-2">{otherActions}</div>}
        {(receiptUpload || (status === "Requested" && otherActions.length > 0)) && (
          <div className="grid gap-3.5">
            {receiptUpload}
            {status === "Requested" && otherActions.length > 0 && (
              <div className="grid gap-3.5">
                {receiptUpload && <div className="flex items-center gap-2.5 text-[12px] text-muted-foreground"><span className="h-px flex-1 bg-border" />or<span className="h-px flex-1 bg-border" /></div>}
                <div className="[&>button]:h-auto [&>button]:min-h-[30px] [&>button]:w-full [&>button]:whitespace-normal [&>button]:py-1.5 [&>button:not(:disabled)]:text-muted-foreground">{otherActions}</div>
              </div>
            )}
          </div>
        )}
        {uploadedNotice}
        {documentRow}
        {replaceUpload}
        {details.length > 0 && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12.5px]">
            {details.map((d) => (
              <div key={d.label} className="contents">
                <dt className="text-muted-foreground">{d.label}</dt>
                <dd className="text-right font-semibold tabular-nums text-foreground">{d.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </Card>
  );
}
