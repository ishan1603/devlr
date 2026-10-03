import type { Metadata } from "next";
import Link from "next/link";
import { getMe } from "@/lib/profile";
import { createClient } from "@/lib/server";
import { Page, PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Learn" };

export default async function LearnPage() {
  const me = (await getMe())!;
  const supabase = await createClient();

  // Get the most recent active question for this user
  const { data: progress } = await supabase
    .from("learn_progress")
    .select(`
      sent_at, revealed_at, self_rating,
      item:learn_items (
        id, question, status,
        topic:learn_topics ( title, format, difficulty )
      )
    `)
    .eq("user_id", me.profile.user_id)
    .order("sent_at", { ascending: false })
    .limit(5);

  const active = progress?.[0];
  const history = progress?.slice(1) || [];

  return (
    <Page className="space-y-12">
      <PageHeader 
        title="Learn" 
        description={`A daily question to test your knowledge on ${me.profile.level || "intermediate"} topics.`} 
      />

      {!active ? (
        <div className="surface-sunken rounded-lg p-8 text-center text-subtle">
          <p>You haven't received any learning questions yet.</p>
          <p className="mt-2 text-sm">We'll send your first one soon.</p>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="surface border border-accent/20 rounded-lg p-6 space-y-4">
            <div className="flex items-center gap-2 text-sm text-accent">
              <span className="px-2 py-0.5 rounded-full bg-accent-soft">
                {((active.item as any)?.topic as any)?.difficulty}
              </span>
              <span>{((active.item as any)?.topic as any)?.format}</span>
            </div>
            
            <h2 className="text-xl font-medium">{((active.item as any)?.topic as any)?.title}</h2>
            <p className="text-muted leading-relaxed whitespace-pre-wrap">
              {(active.item as any)?.question}
            </p>

            <div className="pt-4 border-t border-white/5 flex items-center justify-between">
              {active.revealed_at ? (
                <span className="text-success text-sm">You've completed this!</span>
              ) : (
                <Link
                  href={`/learn/${(active.item as any)?.id}`}
                  className="px-4 py-2 bg-accent text-on-accent rounded-md text-sm font-medium hover:bg-accent-fill transition-colors"
                >
                  Reveal Answer
                </Link>
              )}
            </div>
          </div>
        </div>
      )}

      {history.length > 0 && (
        <section className="space-y-4">
          <h3 className="text-sm font-medium text-subtle uppercase tracking-wider">Past Questions</h3>
          <div className="space-y-2">
            {history.map((h, i) => (
              <Link 
                key={i} 
                href={`/learn/${(h.item as any)?.id}`}
                className="block p-4 surface-sunken rounded-lg hover:surface transition-colors border border-transparent hover:border-white/5"
              >
                <div className="flex justify-between items-center">
                  <span className="font-medium text-muted">{((h.item as any)?.topic as any)?.title}</span>
                  {h.revealed_at && <span className="text-xs text-subtle">Completed</span>}
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}
    </Page>
  );
}
