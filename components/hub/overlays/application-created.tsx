"use client";

import { useRef } from "react";

import { I } from "../icons";
import { Btn } from "../primitives";
import { Modal } from "./modal";
import { useOverlays } from "./overlay-provider";

/**
 * L7: the step between a saved wizard application and its Requirements workflow. That workflow
 * opens at its own "Step 1 of 6", which otherwise reads as the wizard restarting
 * (`../docs/meeting_notes_Nov_20.md`). Nothing is created or sent here; dismissing it leaves the
 * saved application reachable from Applications and the client profile.
 */
export function ApplicationCreatedModal({ applicationId, onClose }: { applicationId: string; onClose: () => void }) {
  const overlays = useOverlays();
  // The requirements overlay replaces this one; a second click before it renders must not reopen it.
  const begun = useRef(false);
  const begin = () => {
    if (begun.current) return;
    begun.current = true;
    overlays.openApplicationRequirements(applicationId);
  };

  return (
    <Modal onClose={onClose} maxWidth={440}>
      <div className="mb-3 flex items-center gap-3">
        <div className="grid size-10 shrink-0 place-items-center rounded-[10px] bg-brand-soft text-brand-hover">
          <I.check size={20} />
        </div>
        <h3 className="text-[16px] font-bold tracking-[-0.01em]">Application created</h3>
      </div>
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        Your application has been saved. Next, collect and verify the required documents in the Requirements workflow. You do
        not need to enter the application again.
      </p>
      <div className="mt-5 flex items-center justify-end gap-2.5">
        <Btn onClick={onClose}>Close</Btn>
        <Btn variant="primary" autoFocus onClick={begin}>
          Begin requirements
        </Btn>
      </div>
    </Modal>
  );
}
