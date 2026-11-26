"use client";

import { useActionState, useRef } from "react";

import { deleteClientAction, type ClientFormState } from "@/app/(app)/clients/actions";
import { useOverlays } from "@/components/hub/overlays/overlay-provider";

const DEFAULT_CLASS =
  "inline-flex h-9 items-center rounded-md border border-red-border bg-red-soft px-3.5 text-[13px] font-semibold text-red transition-colors hover:opacity-90 disabled:opacity-60";

/** `className` lets callers render this as a menu row; the confirm + error handling stay put. */
export function DeleteClientButton({ id, className }: { id: string; className?: string }) {
  const { confirm } = useOverlays();
  const inFlightRef = useRef(false);
  const confirmedSubmissionRef = useRef(false);
  const [state, action, pending] = useActionState<ClientFormState, FormData>(
    async (previous, formData) => {
      try {
        return await deleteClientAction(previous, formData);
      } finally {
        inFlightRef.current = false;
      }
    },
    {},
  );

  return (
    <form
      action={action}
      onSubmit={async (e) => {
        if (confirmedSubmissionRef.current) {
          confirmedSubmissionRef.current = false;
          return;
        }
        e.preventDefault();
        if (pending || inFlightRef.current) return;
        const form = e.currentTarget;
        inFlightRef.current = true;
        let submitted = false;
        try {
          const confirmed = await confirm({
            kind: "danger",
            title: "Delete client?",
            message: "Delete this client? This cannot be undone.",
            confirmLabel: "Delete",
            cancelLabel: "Cancel",
          });
          if (!confirmed || !form.isConnected) return;
          // Re-enter React's form action context, consuming this approval exactly once.
          confirmedSubmissionRef.current = true;
          form.requestSubmit();
          submitted = !confirmedSubmissionRef.current;
        } finally {
          confirmedSubmissionRef.current = false;
          if (!submitted) inFlightRef.current = false;
        }
      }}
    >
      <input type="hidden" name="id" value={id} />
      <button
        type="submit"
        disabled={pending}
        className={className ?? DEFAULT_CLASS}
      >
        {pending ? "Deleting…" : "Delete"}
      </button>
      {state?.error ? <p className="px-3.5 py-1.5 text-[12px] leading-snug text-red">{state.error}</p> : null}
    </form>
  );
}
