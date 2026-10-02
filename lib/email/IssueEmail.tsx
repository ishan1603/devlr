import * as React from "react";
import { formatStars } from "@/lib/modules/pulse";
import type {
  EolSection,
  GuardEntry,
  GuardSection,
  Issue,
  LearnSection,
  ReposSection,
  Section,
  StoriesSection,
  StoryItem,
} from "@/lib/delivery/issue";

/**
 * The Devlr issue, as an email.
 *
 * Constraints that shape everything here: tables rather than flex or grid,
 * every style inline (several clients strip <style>), system fonts only, and
 * no images at all. An image-heavy mail with little text is a classic spam
 * signal, and a reading email has nothing to load anyway. Width is capped at
 * 600px, the widest that reliably survives Outlook.
 *
 * Colours live in this file, not in globals.css, because an email cannot read
 * CSS variables. The baseline is light; the <style> block upgrades clients
 * that honour `prefers-color-scheme` to a dark version.
 *
 * The document shell (html, head, body, preheader) is written out below
 * rather than imported. It is four elements, and the package that used to
 * supply them was deprecated on npm, which Repo Guard's first scan of this
 * very repo is what pointed out.
 */

export interface IssueEmailProps {
  issue: Issue;
  links: {
    web: string;
    preferences: string;
    unsubscribe: string;
    feed?: string;
  };
  recipient: string;
}

const C = {
  page: "#f3f3ef",
  card: "#ffffff",
  ink: "#111113",
  body: "#3d3d45",
  // The lightest grey that still clears 4.5:1 on the card and the page.
  muted: "#6c6c77",
  line: "#e6e6e0",
  mastBg: "#0c0c0e",
  mastInk: "#f5f5f1",
  mastMuted: "#8b8b95",
  lime: "#bef264",
  accent: "#3f6212",
  sunken: "#f6f6f2",
  danger: "#b91c1c",
  warning: "#955a06",
};

const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";

/**
 * Dark mode for clients that support it (Apple Mail, Outlook for Mac, some
 * webmail). Classes are only hooks for this block; every element still carries
 * its full light styling inline, so a client that drops <style> loses nothing.
 */
const DARK_CSS = `
:root { color-scheme: light dark; supported-color-schemes: light dark; }
@media (prefers-color-scheme: dark) {
  .d-page { background: #0b0b0d !important; }
  .d-card { background: #141417 !important; border-color: #26262c !important; }
  .d-ink, .d-ink a { color: #f2f1ee !important; }
  .d-body { color: #b9b9c2 !important; }
  .d-muted, .d-muted a { color: #85858f !important; }
  .d-line { border-color: #26262c !important; }
  .d-accent { color: #bef264 !important; }
  .d-sunken { background: #1c1c20 !important; }
  /* The light-theme warning and danger colours are too dark to read on a dark
     card, so the countdown gets brighter ones here. */
  .d-warning { color: #fbbf24 !important; }
  .d-danger { color: #f87171 !important; }
}
@media only screen and (max-width: 620px) {
  .m-pad { padding-left: 20px !important; padding-right: 20px !important; }
  .m-lead { font-size: 20px !important; }
}
`;

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

const PREHEADER_LENGTH = 150;
/**
 * Invisible filler after the preheader: a no-break space and six zero-width
 * marks. Without it a mail client pads the inbox preview line with whatever
 * comes next in the body, which here would be the masthead's date and command.
 */
const PREHEADER_FILL = String.fromCharCode(0xa0, 0x200c, 0x200b, 0x200d, 0x200e, 0x200f, 0xfeff);

/** The line an inbox shows beside the subject. Hidden in the message itself. */
function Preheader({ text }: { text: string }) {
  const shown = text.slice(0, PREHEADER_LENGTH);
  return (
    <div style={{ display: "none", overflow: "hidden", lineHeight: "1px", opacity: 0, maxHeight: 0, maxWidth: 0 }}>
      {shown}
      <div>{PREHEADER_FILL.repeat(PREHEADER_LENGTH - shown.length)}</div>
    </div>
  );
}

function Table({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} border={0} style={style}>
      <tbody>{children}</tbody>
    </table>
  );
}

/** `// news`: the section marker. Reads as a code comment, which is the joke. */
function SectionLabel({ label }: { label: string }) {
  return (
    <tr>
      <td className="m-pad" style={{ padding: "26px 36px 0 36px" }}>
        <div
          className="d-line"
          style={{ borderTop: `1px solid ${C.line}`, paddingTop: 18, fontFamily: MONO, fontSize: 12 }}
        >
          <span className="d-muted" style={{ color: C.muted }}>
            {"// "}
          </span>
          <span className="d-accent" style={{ color: C.accent, fontWeight: 600 }}>
            {label}
          </span>
        </div>
      </td>
    </tr>
  );
}

function Story({ item, lead }: { item: StoryItem; lead: boolean }) {
  const meta = [item.site, ...item.meta].filter(Boolean);

  return (
    <tr>
      <td className="m-pad" style={{ padding: "16px 36px 0 36px" }}>
        <div
          className={lead ? "d-ink m-lead" : "d-ink"}
          style={{
            fontFamily: SANS,
            fontSize: lead ? 22 : 17,
            lineHeight: lead ? "29px" : "24px",
            fontWeight: 600,
            letterSpacing: lead ? "-0.3px" : "-0.1px",
            color: C.ink,
          }}
        >
          <a href={item.url} style={{ color: C.ink, textDecoration: "none" }}>
            {item.title}
          </a>
        </div>

        {meta.length > 0 && (
          <div
            className="d-muted"
            style={{ fontFamily: MONO, fontSize: 12, lineHeight: "18px", color: C.muted, paddingTop: 5 }}
          >
            {meta.join("  ·  ")}
          </div>
        )}

        <div
          className="d-body"
          style={{ fontFamily: SANS, fontSize: 15, lineHeight: "24px", color: C.body, paddingTop: 8 }}
        >
          {item.summary}
        </div>

        {item.alsoCoveredBy.length > 0 && (
          <div
            className="d-muted"
            style={{ fontFamily: SANS, fontSize: 13, lineHeight: "20px", color: C.muted, paddingTop: 6 }}
          >
            Also covered by{" "}
            {item.alsoCoveredBy.map((other, i) => (
              <React.Fragment key={other.url}>
                {i > 0 && ", "}
                <a href={other.url} style={{ color: C.muted, textDecoration: "underline" }}>
                  {other.name}
                </a>
              </React.Fragment>
            ))}
          </div>
        )}

        {item.feedback && (
          <div
            className="d-muted"
            style={{ fontFamily: MONO, fontSize: 12, lineHeight: "18px", color: C.muted, paddingTop: 8 }}
          >
            <a href={item.feedback.more} style={{ color: C.muted, textDecoration: "none" }}>
              [+] more like this
            </a>
            {"\u00a0\u00a0\u00a0"}
            <a href={item.feedback.less} style={{ color: C.muted, textDecoration: "none" }}>
              [-] less like this
            </a>
          </div>
        )}
      </td>
    </tr>
  );
}

function Stories({ section, isFirst }: { section: StoriesSection; isFirst: boolean }) {
  return (
    <>
      <SectionLabel label={section.label} />
      {section.items.map((item, i) => (
        <Story key={item.ref} item={item} lead={isFirst && i === 0} />
      ))}
    </>
  );
}

function Repos({ section }: { section: ReposSection }) {
  return (
    <>
      <SectionLabel label={section.label} />
      {section.repos.map((repo) => (
        <tr key={repo.fullName}>
          <td className="m-pad" style={{ padding: "14px 36px 0 36px" }}>
            <div style={{ fontFamily: MONO, fontSize: 14, lineHeight: "21px", fontWeight: 600 }}>
              <a href={repo.url} className="d-ink" style={{ color: C.ink, textDecoration: "none" }}>
                {repo.fullName}
              </a>
            </div>
            <div
              className="d-muted"
              style={{ fontFamily: MONO, fontSize: 12, lineHeight: "18px", color: C.muted, paddingTop: 2 }}
            >
              {[`${formatStars(repo.stars)} stars`, repo.language].filter(Boolean).join("  ·  ")}
            </div>
            <div
              className="d-body"
              style={{ fontFamily: SANS, fontSize: 14, lineHeight: "22px", color: C.body, paddingTop: 5 }}
            >
              {repo.blurb || repo.description}
            </div>
          </td>
        </tr>
      ))}
    </>
  );
}

/** Colour for the countdown, plus the class that re-colours it in dark mode. */
function eolTone(daysLeft: number): { color: string; className: string } {
  if (daysLeft <= 7) return { color: C.danger, className: "d-line d-danger" };
  if (daysLeft <= 30) return { color: C.warning, className: "d-line d-warning" };
  return { color: C.muted, className: "d-line d-muted" };
}

export function eolPhrase(daysLeft: number): string {
  if (daysLeft < 0) return `ended ${-daysLeft} ${-daysLeft === 1 ? "day" : "days"} ago`;
  if (daysLeft === 0) return "ends today";
  return `${daysLeft} ${daysLeft === 1 ? "day" : "days"} left`;
}

function Eol({ section }: { section: EolSection }) {
  return (
    <>
      <SectionLabel label={section.label} />
      <tr>
        <td className="m-pad" style={{ padding: "14px 36px 0 36px" }}>
          <Table>
            {section.entries.map((entry, index) => {
              // No rule under the last row: the next section draws its own
              // above its label, and two lines a few pixels apart read as a bug.
              const rule = index === section.entries.length - 1 ? "none" : `1px solid ${C.line}`;
              const tone = eolTone(entry.daysLeft);
              return (
              <tr key={entry.ref}>
                <td
                  className="d-line"
                  style={{ padding: "10px 0", borderBottom: rule, verticalAlign: "top" }}
                >
                  <div
                    className="d-ink"
                    style={{ fontFamily: SANS, fontSize: 15, lineHeight: "22px", fontWeight: 600, color: C.ink }}
                  >
                    <a href={entry.link} style={{ color: C.ink, textDecoration: "none" }}>
                      {entry.product} {entry.cycle}
                    </a>
                  </div>
                  <div
                    className="d-muted"
                    style={{ fontFamily: MONO, fontSize: 12, lineHeight: "18px", color: C.muted, paddingTop: 2 }}
                  >
                    end of life {entry.eolDate}
                    {entry.latest ? `  ·  current is ${entry.latest}` : ""}
                  </div>
                </td>
                <td
                  className={tone.className}
                  align="right"
                  style={{
                    padding: "10px 0",
                    borderBottom: rule,
                    verticalAlign: "top",
                    whiteSpace: "nowrap",
                    fontFamily: MONO,
                    fontSize: 12,
                    lineHeight: "22px",
                    fontWeight: 600,
                    color: tone.color,
                  }}
                >
                  {eolPhrase(entry.daysLeft)}
                </td>
              </tr>
              );
            })}
          </Table>
        </td>
      </tr>
    </>
  );
}

/** Colour for a priority or a grade, plus the class that re-colours it in dark mode. */
function toneFor(level: "bad" | "warn" | "good" | "quiet"): { color: string; className: string } {
  switch (level) {
    case "bad":
      return { color: C.danger, className: "d-danger" };
    case "warn":
      return { color: C.warning, className: "d-warning" };
    case "good":
      return { color: C.accent, className: "d-accent" };
    default:
      return { color: C.muted, className: "d-muted" };
  }
}

const priorityTone = (priority: GuardEntry["priority"]) =>
  toneFor(priority === "urgent" ? "bad" : priority === "high" ? "warn" : "quiet");
const gradeTone = (grade: string) => toneFor(grade === "A" || grade === "B" ? "good" : grade === "C" ? "warn" : "bad");

function GuardItem({ entry }: { entry: GuardEntry }) {
  const tone = priorityTone(entry.priority);
  return (
    <tr>
      <td className="m-pad" style={{ padding: "18px 36px 0 36px" }}>
        <div style={{ fontFamily: MONO, fontSize: 12, lineHeight: "18px" }}>
          <span className={tone.className} style={{ color: tone.color, fontWeight: 600 }}>
            [{entry.priority}]
          </span>
          <span className="d-muted" style={{ color: C.muted }}>
            {"  "}
            {entry.repo}
          </span>
        </div>

        <div
          className="d-ink"
          style={{ fontFamily: SANS, fontSize: 17, lineHeight: "24px", fontWeight: 600, letterSpacing: "-0.1px", color: C.ink, paddingTop: 4 }}
        >
          <a href={entry.url} style={{ color: C.ink, textDecoration: "none" }}>
            {entry.title}
          </a>
        </div>

        {entry.meta.length > 0 && (
          <div
            className="d-muted"
            style={{ fontFamily: MONO, fontSize: 12, lineHeight: "18px", color: C.muted, paddingTop: 5 }}
          >
            {entry.meta.join("  ·  ")}
          </div>
        )}

        <div
          className="d-body"
          style={{ fontFamily: SANS, fontSize: 15, lineHeight: "24px", color: C.body, paddingTop: 8 }}
        >
          {entry.action}
        </div>

        {entry.command && (
          <div
            className="d-sunken d-line d-ink"
            style={{
              marginTop: 10,
              padding: "10px 12px",
              background: C.sunken,
              border: `1px solid ${C.line}`,
              borderRadius: 8,
              fontFamily: MONO,
              fontSize: 13,
              lineHeight: "20px",
              color: C.ink,
              // A long package name must wrap, not push the email wider than the screen.
              wordBreak: "break-all",
            }}
          >
            <span className="d-muted" style={{ color: C.muted }}>
              ${" "}
            </span>
            {entry.command}
          </div>
        )}
      </td>
    </tr>
  );
}

function Guard({ section }: { section: GuardSection }) {
  if (section.redacted) {
    return (
      <>
        <SectionLabel label={section.label} />
        <tr>
          <td className="m-pad" style={{ padding: "14px 36px 0 36px" }}>
            <div
              className="d-body"
              style={{ fontFamily: SANS, fontSize: 15, lineHeight: "24px", color: C.body }}
            >
              This issue reported on your repositories. Those details stay in your inbox and your account, and are
              not shown on a page that opens with a link.{" "}
              <a href={section.url} className="d-ink" style={{ color: C.ink, textDecoration: "underline" }}>
                Open Repo Guard
              </a>
            </div>
          </td>
        </tr>
      </>
    );
  }

  return (
    <>
      <SectionLabel label={section.label} />

      {section.repos.length > 0 && (
        <tr>
          <td className="m-pad" style={{ padding: "12px 36px 0 36px" }}>
            <Table>
              {section.repos.map((repo) => {
                const tone = gradeTone(repo.grade);
                return (
                  <tr key={repo.fullName}>
                    <td style={{ padding: "3px 0", fontFamily: MONO, fontSize: 13, lineHeight: "20px" }}>
                      <a href={repo.url} className="d-ink" style={{ color: C.ink, textDecoration: "none" }}>
                        {repo.fullName}
                      </a>
                    </td>
                    <td
                      align="right"
                      className="d-muted"
                      style={{ padding: "3px 0", whiteSpace: "nowrap", fontFamily: MONO, fontSize: 12, lineHeight: "20px", color: C.muted }}
                    >
                      <span className={tone.className} style={{ color: tone.color, fontWeight: 600 }}>
                        {repo.grade}
                      </span>
                      {`  ${repo.score}/100  ·  ${repo.toFix} to fix`}
                    </td>
                  </tr>
                );
              })}
            </Table>
          </td>
        </tr>
      )}

      {section.entries.map((entry) => (
        <GuardItem key={entry.ref} entry={entry} />
      ))}

      <tr>
        <td className="m-pad" style={{ padding: "16px 36px 0 36px" }}>
          <div
            className="d-muted"
            style={{ fontFamily: SANS, fontSize: 13, lineHeight: "20px", color: C.muted }}
          >
            {section.also.length > 0 && <>Also needs attention: {section.also.join(", ")}. </>}
            <a href={section.url} style={{ color: C.muted, textDecoration: "underline" }}>
              See every finding and its advisories
            </a>
          </div>
        </td>
      </tr>
    </>
  );
}

function Learn({ section }: { section: LearnSection }) {
  return (
    <>
      <SectionLabel label={section.label} />
      <tr>
        <td className="m-pad" style={{ padding: "14px 36px 0 36px" }}>
          <div
            className="d-ink"
            style={{ fontFamily: SANS, fontSize: 17, lineHeight: "24px", fontWeight: 600, color: C.ink }}
          >
            {section.title}
          </div>
          <div
            className="d-body"
            style={{ fontFamily: SANS, fontSize: 15, lineHeight: "24px", color: C.body, paddingTop: 8 }}
          >
            {section.question}
          </div>

          {section.hints.length > 0 && (
            <div className="d-sunken d-line" style={{ marginTop: 16, padding: "12px 16px", background: C.sunken, border: `1px solid ${C.line}`, borderRadius: 8 }}>
              <div className="d-muted" style={{ fontFamily: MONO, fontSize: 12, fontWeight: 600, color: C.muted, paddingBottom: 4 }}>
                HINTS
              </div>
              <ul style={{ margin: 0, paddingLeft: 18, fontFamily: SANS, fontSize: 14, color: C.body, lineHeight: "20px" }}>
                {section.hints.map((hint, i) => (
                  <li key={i} className="d-body" style={{ paddingBottom: i === section.hints.length - 1 ? 0 : 4 }}>
                    {hint}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div style={{ paddingTop: 16 }}>
            <a
              href={section.url}
              style={{
                display: "inline-block",
                background: C.accent,
                color: "#ffffff",
                fontFamily: SANS,
                fontSize: 14,
                fontWeight: 600,
                textDecoration: "none",
                padding: "8px 16px",
                borderRadius: 6,
              }}
            >
              Reveal Answer
            </a>
          </div>
        </td>
      </tr>
    </>
  );
}

function renderSection(section: Section, index: number, sections: Section[]) {
  const key = `${section.module}-${section.label}`;
  switch (section.type) {
    case "stories":
      // The lead is the first story in the issue, even when a section of
      // another kind (Repo Guard, EOL Watch) comes before it.
      return <Stories key={key} section={section} isFirst={sections.findIndex((s) => s.type === "stories") === index} />;
    case "repos":
      return <Repos key={key} section={section} />;
    case "eol":
      return <Eol key={key} section={section} />;
    case "guard":
      return <Guard key={key} section={section} />;
    case "learn":
      return <Learn key={key} section={section} />;
  }
}

export default function IssueEmail({ issue, links, recipient }: IssueEmailProps) {
  const isoDay = issue.date.slice(0, 10);
  const hasFeedback = issue.sections.some((s) => s.type === "stories" && s.items.some((item) => item.feedback));

  return (
    <html lang="en" dir="ltr">
      {/* eslint-disable-next-line @next/next/no-head-element -- an email document, not a Next.js page */}
      <head>
        <meta content="text/html; charset=UTF-8" httpEquiv="Content-Type" />
        {/* Without this a phone lays the message out 980px wide and shrinks it
            to fit, which makes the text tiny and the media queries below never
            apply. */}
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* Stops Apple Mail from rescaling the layout on small screens. */}
        <meta name="x-apple-disable-message-reformatting" />
        <meta name="color-scheme" content="light dark" />
        <meta name="supported-color-schemes" content="light dark" />
        <style>{DARK_CSS}</style>
      </head>
      <body className="d-page" style={{ margin: 0, padding: 0, background: C.page }}>
        <Preheader text={issue.preheader} />
        <Table style={{ background: C.page }}>
          <tr>
            <td className="d-page" align="center" style={{ padding: "28px 12px", background: C.page }}>
              <table
                role="presentation"
                width={600}
                cellPadding={0}
                cellSpacing={0}
                border={0}
                className="d-card"
                style={{
                  width: "100%",
                  maxWidth: 600,
                  background: C.card,
                  border: `1px solid ${C.line}`,
                  borderRadius: 14,
                  // Clips the masthead to the rounded corners where supported.
                  overflow: "hidden",
                }}
              >
                <tbody>
                  {/* Masthead. Dark in both themes: it is the brand mark. */}
                  <tr>
                    <td className="m-pad" style={{ background: C.mastBg, padding: "22px 36px 20px 36px" }}>
                      <Table>
                        <tr>
                          <td
                            style={{
                              fontFamily: SANS,
                              fontSize: 22,
                              lineHeight: "26px",
                              fontWeight: 700,
                              letterSpacing: "-0.5px",
                              color: C.mastInk,
                            }}
                          >
                            Devlr<span style={{ color: C.lime }}>.</span>
                          </td>
                          <td
                            align="right"
                            style={{ fontFamily: MONO, fontSize: 12, lineHeight: "26px", color: C.mastMuted }}
                          >
                            {formatDate(issue.date)}
                          </td>
                        </tr>
                      </Table>
                      <div style={{ fontFamily: MONO, fontSize: 12, lineHeight: "18px", color: C.mastMuted, paddingTop: 10 }}>
                        <span style={{ color: C.lime }}>$</span> devlr read --issue {isoDay}
                      </div>
                    </td>
                  </tr>

                  {issue.intro && (
                    <tr>
                      <td className="m-pad" style={{ padding: "28px 36px 0 36px" }}>
                        <div
                          className="d-ink"
                          style={{ fontFamily: SANS, fontSize: 17, lineHeight: "27px", color: C.ink }}
                        >
                          {issue.intro}
                        </div>
                      </td>
                    </tr>
                  )}

                  {issue.sections.map(renderSection)}

                  <tr>
                    <td className="m-pad" style={{ padding: "30px 36px 30px 36px" }}>
                      <div
                        className="d-line d-muted"
                        style={{
                          borderTop: `1px solid ${C.line}`,
                          paddingTop: 18,
                          fontFamily: SANS,
                          fontSize: 12,
                          lineHeight: "20px",
                          color: C.muted,
                        }}
                      >
                        Sent to {recipient} because you set this up at Devlr.
                        {hasFeedback && " The [+] and [-] links tune what you get next."}
                        <br />
                        <a href={links.preferences} style={{ color: C.muted, textDecoration: "underline" }}>
                          Change what you get
                        </a>
                        {"  ·  "}
                        <a href={links.web} style={{ color: C.muted, textDecoration: "underline" }}>
                          Read in browser
                        </a>
                        {links.feed && (
                          <>
                            {"  ·  "}
                            <a href={links.feed} style={{ color: C.muted, textDecoration: "underline" }}>
                              RSS
                            </a>
                          </>
                        )}
                        {"  ·  "}
                        <a href={links.unsubscribe} style={{ color: C.muted, textDecoration: "underline" }}>
                          Unsubscribe
                        </a>
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </td>
          </tr>
        </Table>
      </body>
    </html>
  );
}
