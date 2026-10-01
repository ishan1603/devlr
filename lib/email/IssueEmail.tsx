import * as React from "react";
import { Body, Head, Html, Preview } from "@react-email/components";
import { formatStars } from "@/lib/modules/pulse";
import type {
  EolSection,
  Issue,
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
  muted: "#7b7b86",
  line: "#e6e6e0",
  mastBg: "#0c0c0e",
  mastInk: "#f5f5f1",
  mastMuted: "#8b8b95",
  lime: "#bef264",
  accent: "#3f6212",
  sunken: "#f6f6f2",
  danger: "#b91c1c",
  warning: "#a16207",
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

function eolTone(daysLeft: number): string {
  if (daysLeft <= 7) return C.danger;
  if (daysLeft <= 30) return C.warning;
  return C.muted;
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
                  className="d-line"
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
                    color: eolTone(entry.daysLeft),
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

function renderSection(section: Section, index: number) {
  const key = `${section.module}-${section.label}`;
  switch (section.type) {
    case "stories":
      return <Stories key={key} section={section} isFirst={index === 0} />;
    case "repos":
      return <Repos key={key} section={section} />;
    case "eol":
      return <Eol key={key} section={section} />;
  }
}

export default function IssueEmail({ issue, links, recipient }: IssueEmailProps) {
  const isoDay = issue.date.slice(0, 10);

  return (
    <Html lang="en">
      <Head>
        <meta name="color-scheme" content="light dark" />
        <meta name="supported-color-schemes" content="light dark" />
        <style>{DARK_CSS}</style>
      </Head>
      <Preview>{issue.preheader}</Preview>
      <Body className="d-page" style={{ margin: 0, padding: 0, background: C.page }}>
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
                        Sent to {recipient} because you set this up at Devlr. The [+] and [-] links
                        tune what you get next.
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
      </Body>
    </Html>
  );
}
