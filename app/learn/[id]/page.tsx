import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase-admin";
import Link from "next/link";

export const metadata: Metadata = { title: "Learn" };

export default async function LearnRevealPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = createAdminClient();

  const { data: item } = await supabase
    .from("learn_items")
    .select(`
      *,
      topic:learn_topics ( title, domain, format, difficulty )
    `)
    .eq("id", Number(id))
    .eq("status", "approved")
    .maybeSingle();

  if (!item) notFound();

  return (
    <div className="min-h-screen bg-bg text-text selection:bg-accent/20">
      <header className="border-b border-white/5 bg-surface/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-3xl mx-auto px-6 h-14 flex items-center justify-between">
          <Link href="/" className="font-mono text-sm tracking-widest uppercase text-muted hover:text-accent transition-colors">
            Devlr
          </Link>
          <span className="text-xs text-subtle px-2 py-1 rounded bg-surface-sunken">
            {item.topic?.difficulty} {item.topic?.format}
          </span>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-16 space-y-16">
        <section className="space-y-6">
          <h1 className="text-3xl font-medium tracking-tight text-balance">
            {item.topic?.title}
          </h1>
          
          <div className="surface-sunken rounded-lg p-8 border border-white/5 space-y-4">
            <h3 className="text-xs font-mono tracking-widest uppercase text-subtle">Question</h3>
            <p className="text-lg leading-relaxed">{item.question}</p>
            
            {item.constraints && item.constraints.length > 0 && (
              <div className="pt-4">
                <h4 className="text-sm font-medium text-muted mb-2">Constraints</h4>
                <ul className="list-disc list-inside space-y-1 text-sm text-subtle">
                  {item.constraints.map((c: string, i: number) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>

        <section className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700 delay-150 fill-mode-both">
          <div className="flex items-center gap-4">
            <div className="h-px bg-white/5 flex-1" />
            <h2 className="text-sm font-mono tracking-widest uppercase text-accent">The Answer</h2>
            <div className="h-px bg-white/5 flex-1" />
          </div>

          <div className="prose prose-invert prose-pre:bg-surface-sunken prose-pre:border prose-pre:border-white/5 max-w-none">
            {/* Note: in a real app we'd use react-markdown here, but for simplicity we render the raw text or parse it. */}
            <div className="whitespace-pre-wrap leading-relaxed text-muted">
              {item.answer_md}
            </div>
          </div>

          {item.diagram_ascii && (
            <div className="space-y-2 pt-8">
              <h3 className="text-xs font-mono tracking-widest uppercase text-subtle">Architecture</h3>
              <pre className="p-6 rounded-lg bg-surface-sunken border border-white/5 overflow-x-auto text-xs text-muted leading-tight font-mono">
                {item.diagram_ascii}
              </pre>
            </div>
          )}

          {item.references && item.references.length > 0 && (
            <div className="space-y-4 pt-12 border-t border-white/5">
              <h3 className="text-sm font-medium text-muted">Real-world references</h3>
              <ul className="space-y-2">
                {item.references.map((ref: string, i: number) => (
                  <li key={i}>
                    <a href={ref} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline text-sm break-all">
                      {ref}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
