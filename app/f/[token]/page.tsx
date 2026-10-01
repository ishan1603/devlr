import type { Metadata } from "next";
import FeedbackConfirm from "@/components/FeedbackConfirm";

export const metadata: Metadata = {
  title: "Feedback",
  robots: { index: false, follow: false },
};

/**
 * Where "more like this" and "less like this" land.
 *
 * The page itself records nothing. The vote is sent by a script after it
 * loads, because mail scanners follow every link in a message and would
 * otherwise cast votes on a reader's behalf.
 */
export default async function FeedbackPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <FeedbackConfirm token={token} />;
}
