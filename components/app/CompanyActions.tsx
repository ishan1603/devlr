"use client";

import { useState } from "react";
import { Send } from "lucide-react";
import { Button } from "@/components/ui";
import { useNotification } from "@/contexts/NotificationContext";
import { sendNow } from "@/lib/api-client";

export default function CompanyActions() {
  const { showError, showSuccess } = useNotification();
  const [sending, setSending] = useState(false);

  async function handleSend() {
    setSending(true);
    try {
      await sendNow(["company_radar"]);
      showSuccess("Radar incoming!", "We are compiling the latest updates from your followed companies. It should arrive shortly.");
    } catch (err) {
      showError("Could not trigger issue", err instanceof Error ? err.message : undefined);
    } finally {
      setSending(false);
    }
  }

  return (
    <Button onClick={handleSend} loading={sending}>
      {!sending && <Send className="size-4" />}
      Send company radar now
    </Button>
  );
}
