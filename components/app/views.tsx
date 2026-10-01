import Link from "next/link";
import { ArrowUpRight, Inbox } from "lucide-react";
import HomeActions from "@/components/app/HomeActions";
import { Badge, Card, CardHeader, EmptyState, Eyebrow, Page, PageHeader } from "@/components/ui";
import { MODULE_META, formatTime, frequencyLabel } from "@/lib/modules/meta";
import { tagName } from "@/lib/topics/catalog";
import type { Me } from "@/lib/profile";

/**
 * The app's read-only screens, as plain functions of their data.
 *
 * Pages fetch and pass the result in. Keeping the fetching out of here is what
 * lets the same screens render in /demo with mock data, and it keeps "what does
 * the page show" separate from "where does it come from".
 */

export interface DeliveryRow {
  id: string;
  status: string;
  subject: string | null;
  preheader?: string | null;
  modules?: string[] | null;
  web_token: string;
  created_at: string;
  sent_at: string | null;
  error?: string | null;
  /** Overrides the archive link. The demo points it at the sample email. */
  href?: string;
}

const issueHref = (delivery: DeliveryRow) => delivery.href ?? `/issue/${delivery.web_token}`;

const STATUS_TONE = { sent: "success", sending: "accent", skipped: "neutral", failed: "danger" } as const;
const STATUS_LABEL = { sent: "Sent", sending: "Sending", skipped: "Nothing new", failed: "Failed" } as const;
type Status = keyof typeof STATUS_TONE;

function formatWhen(iso: string, timezone: string, withWeekday = false) {
  try {
    return new Date(iso).toLocaleString("en-US", {
      weekday: withWeekday ? "short" : undefined,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: timezone,
    });
  } catch {
    return new Date(iso).toISOString().slice(0, 16).replace("T", " ");
  }
}

/** A row always says something specific, even when no email went out. */
function subjectOf(delivery: DeliveryRow): string {
  if (delivery.subject) return delivery.subject;
  switch (delivery.status) {
    case "skipped":
      return "Nothing new that day";
    case "failed":
      return "This one could not be sent";
    case "sending":
      return "Being put together now";
    default:
      return "Issue";
  }
}

/* ------------------------------------------------------------------ Home -- */

export function HomeView({
  me,
  deliveries,
  basePath = "/app",
}: {
  me: Me;
  deliveries: DeliveryRow[];
  basePath?: string;
}) {
  const { profile, subscriptions } = me;
  const active = MODULE_META.filter((meta) =>
    subscriptions.some((s) => s.module === meta.module && s.is_active)
  );
  const name = profile.display_name?.split(" ")[0];
  const interests = [...profile.stack, ...profile.domains];

  return (
    <Page>
      <Eyebrow>home</Eyebrow>
      <h1 className="mt-2 text-[28px] font-semibold leading-tight tracking-[-0.025em] sm:text-[34px]">
        {name ? `Hey ${name}.` : "Your inbox, on your terms."}
      </h1>
      <p className="mt-2 max-w-xl text-[15px] text-muted">
        {profile.is_paused
          ? "Email is paused. Your settings are kept, and nothing is sent until you resume."
          : `Issues go out at ${formatTime(profile.send_time)} (${profile.timezone.replace(/_/g, " ")}) on the days something is due.`}
      </p>

      <div className="mt-7">
        <HomeActions paused={profile.is_paused} />
      </div>

      <div className="mt-10 grid gap-5 lg:grid-cols-2">
        <Card className="min-w-0">
          <CardHeader
            title="What you get"
            action={
              <Link href={`${basePath}/schedule`} className="text-[13px] font-medium text-accent hover:underline">
                Change
              </Link>
            }
          />
          {active.length === 0 ? (
            <EmptyState title="Nothing switched on" description="Turn on a module to start getting issues." />
          ) : (
            <ul className="divide-y divide-line">
              {active.map((meta) => {
                const sub = subscriptions.find((s) => s.module === meta.module)!;
                return (
                  <li key={meta.module} className="flex items-center justify-between gap-4 px-5 py-3.5">
                    <span className="text-[14px] font-medium">{meta.name}</span>
                    <span className="font-mono text-[12px] text-subtle">
                      {meta.hasCadence ? frequencyLabel(sub.frequency, sub.custom_interval_days) : "when relevant"}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card className="min-w-0">
          <CardHeader
            title="What it is tuned to"
            action={
              <Link href={`${basePath}/topics`} className="text-[13px] font-medium text-accent hover:underline">
                Edit
              </Link>
            }
          />
          <div className="flex flex-wrap gap-2 p-5">
            {interests.length === 0 ? (
              <p className="text-[13px] text-muted">No topics yet.</p>
            ) : (
              interests.map((slug) => <Badge key={slug}>{tagName(slug)}</Badge>)
            )}
          </div>
        </Card>
      </div>

      <Card className="mt-5">
        <CardHeader
          title="Recent issues"
          action={
            <Link href={`${basePath}/issues`} className="text-[13px] font-medium text-accent hover:underline">
              All issues
            </Link>
          }
        />
        {deliveries.length === 0 ? (
          <EmptyState
            title="No issues yet"
            description="Your first one goes out at your next send time. Or send one now."
          />
        ) : (
          <ul className="divide-y divide-line">
            {deliveries.slice(0, 5).map((delivery) => {
              const status = delivery.status as Status;
              return (
                <li key={delivery.id} className="flex items-center gap-3 px-5 py-3.5 sm:gap-4">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14px] font-medium">{subjectOf(delivery)}</p>
                    <p className="mt-0.5 font-mono text-[12px] text-subtle">
                      {formatWhen(delivery.sent_at ?? delivery.created_at, profile.timezone)}
                    </p>
                  </div>
                  <Badge tone={STATUS_TONE[status] ?? "neutral"} className="shrink-0">
                    {STATUS_LABEL[status] ?? status}
                  </Badge>
                  {status === "sent" && (
                    <a
                      href={issueHref(delivery)}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label="Open issue"
                      className="grid size-8 shrink-0 place-items-center rounded-lg text-subtle transition-colors hover:bg-surface-sunken hover:text-fg"
                    >
                      <ArrowUpRight className="size-4" />
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </Page>
  );
}

/* ---------------------------------------------------------------- Issues -- */

export function IssuesView({ me, deliveries }: { me: Me; deliveries: DeliveryRow[] }) {
  const moduleName = (slug: string) => MODULE_META.find((m) => m.module === slug)?.name ?? slug;

  return (
    <Page>
      <PageHeader
        title="Issues"
        description="Everything Devlr has sent you. Issues stay readable here for 120 days."
      />

      <Card>
        {deliveries.length === 0 ? (
          <EmptyState
            icon={<Inbox className="size-6" />}
            title="No issues yet"
            description="Once your first issue goes out, it will be archived here."
          />
        ) : (
          <ul className="divide-y divide-line">
            {deliveries.map((delivery) => {
              const status = delivery.status as Status;
              const body = (
                <>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] font-medium">{subjectOf(delivery)}</p>
                    {delivery.preheader && (
                      <p className="mt-0.5 truncate text-[13px] text-muted">{delivery.preheader}</p>
                    )}
                    <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[12px] text-subtle">
                      <span>{formatWhen(delivery.sent_at ?? delivery.created_at, me.profile.timezone, true)}</span>
                      {delivery.modules && delivery.modules.length > 0 && (
                        <span>{delivery.modules.map(moduleName).join(", ")}</span>
                      )}
                      {status === "failed" && delivery.error && (
                        <span className="text-danger">{String(delivery.error).slice(0, 80)}</span>
                      )}
                    </p>
                  </div>
                  <Badge tone={STATUS_TONE[status] ?? "neutral"} className="shrink-0">
                    {STATUS_LABEL[status] ?? status}
                  </Badge>
                </>
              );

              return (
                <li key={delivery.id}>
                  {status === "sent" ? (
                    <a
                      href={issueHref(delivery)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group flex items-center gap-3 px-5 py-4 transition-colors hover:bg-surface-sunken sm:gap-4"
                    >
                      {body}
                      <ArrowUpRight className="size-4 shrink-0 text-subtle transition-colors group-hover:text-fg" />
                    </a>
                  ) : (
                    <div className="flex items-center gap-3 px-5 py-4 sm:gap-4">{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </Page>
  );
}
