"use client";

import { useState, useTransition } from "react";
import { toggleFollowCompany } from "@/app/app/companies/actions";
import { useNotification } from "@/contexts/NotificationContext";
import { cx, Spinner } from "@/components/ui";

export default function CompanyFollowButton({
  companyId,
  initialFollowing,
}: {
  companyId: string;
  initialFollowing: boolean;
}) {
  const [isPending, startTransition] = useTransition();
  const [isFollowing, setIsFollowing] = useState(initialFollowing);
  const { showError } = useNotification();

  function handleClick() {
    // Optimistic update
    const nextState = !isFollowing;
    setIsFollowing(nextState);

    startTransition(async () => {
      try {
        await toggleFollowCompany(companyId, !nextState); // pass current state to toggle action
      } catch (err) {
        // Revert on error
        setIsFollowing(!nextState);
        showError("Could not update status", err instanceof Error ? err.message : undefined);
      }
    });
  }

  return (
    <button
      onClick={handleClick}
      disabled={isPending}
      className={cx(
        "px-3 py-1.5 rounded text-xs font-medium transition-colors flex items-center justify-center gap-2",
        isFollowing
          ? "bg-surface-sunken text-muted hover:text-danger hover:bg-danger/10"
          : "bg-accent/10 text-accent hover:bg-accent hover:text-on-accent",
        isPending && "opacity-70 cursor-not-allowed"
      )}
    >
      {isPending && <Spinner className="size-3" />}
      {isFollowing ? "Following" : "Follow"}
    </button>
  );
}
