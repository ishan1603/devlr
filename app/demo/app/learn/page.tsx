import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Learn (Demo)" };

export default function DemoLearnPage() {
  const me = { level: "advanced" };

  const active = {
    sent_at: new Date().toISOString(),
    revealed_at: null,
    item: {
      id: "demo-123",
      question: "Design a distributed rate-limiting system for a multi-region SaaS platform handling 1 million requests per second (RPS) globally. The system must enforce API limits accurately without sacrificing latency, even during partial network partitions between regions.",
      status: "approved",
      topic: { title: "Rate Limiting", format: "system_design", difficulty: "advanced" }
    }
  };

  const history = [
    {
      sent_at: "2026-10-01T00:00:00Z",
      revealed_at: "2026-10-01T10:00:00Z",
      item: {
        id: "demo-122",
        topic: { title: "Idempotency Keys in Payment Gateways" }
      }
    },
    {
      sent_at: "2026-09-30T00:00:00Z",
      revealed_at: "2026-09-30T09:30:00Z",
      item: {
        id: "demo-121",
        topic: { title: "Postgres Advisory Locks vs Redis" }
      }
    }
  ];

  return (
    <div className="max-w-2xl mx-auto space-y-12">
      <header className="space-y-2">
        <h1 className="text-2xl tracking-tight">Learn</h1>
        <p className="text-subtle">
          A daily question to test your knowledge on {me.level || "intermediate"} topics.
        </p>
      </header>

      <div className="space-y-6">
        <div className="surface border border-accent/20 rounded-lg p-6 space-y-4">
          <div className="flex items-center gap-2 text-sm text-accent">
            <span className="px-2 py-0.5 rounded-full bg-accent-soft">
              {active.item.topic.difficulty}
            </span>
            <span>{active.item.topic.format}</span>
          </div>
          
          <h2 className="text-xl font-medium">{active.item.topic.title}</h2>
          <p className="text-muted leading-relaxed whitespace-pre-wrap">
            {active.item.question}
          </p>

          <div className="pt-4 border-t border-white/5 flex items-center justify-between">
            <Link
              href={`/demo/learn/${active.item.id}`}
              className="px-4 py-2 bg-accent text-on-accent rounded-md text-sm font-medium hover:bg-accent-fill transition-colors"
            >
              Reveal Answer
            </Link>
          </div>
        </div>
      </div>

      <section className="space-y-4">
        <h3 className="text-sm font-medium text-subtle uppercase tracking-wider">Past Questions</h3>
        <div className="space-y-2">
          {history.map((h, i) => (
            <Link 
              key={i} 
              href={`/demo/learn/${h.item.id}`}
              className="block p-4 surface-sunken rounded-lg hover:surface transition-colors border border-transparent hover:border-white/5"
            >
              <div className="flex justify-between items-center">
                <span className="font-medium text-muted">{h.item.topic.title}</span>
                <span className="text-xs text-subtle">Completed</span>
              </div>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
