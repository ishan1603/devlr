import nodemailer, { type SendMailOptions } from "nodemailer";
import type { PoolArticle } from "@/lib/newsletter/pool";
import type { Briefing } from "@/lib/newsletter/briefing";
import { renderNewsletterHtml, renderNewsletterText } from "@/lib/email/render";

export interface SendNewsletterInput {
  to: string;
  articles: PoolArticle[];
  briefing: Briefing;
  unsubscribeToken: string;
  date?: Date;
}

function appUrl() {
  return (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

function createTransporter() {
  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });
}

/**
 * Subject line.
 *
 * Leads with the reader's actual topics and the date. Deliberately avoids the
 * things filters weight against: all-caps, exclamation marks, "free", "act now",
 * and emoji in the subject.
 */
function buildSubject(articles: PoolArticle[], date: Date) {
  const topics = [...new Set(articles.map((a) => a.category))];
  const shown = topics.slice(0, 2).join(" and ");
  const rest = topics.length > 2 ? ` +${topics.length - 2} more` : "";
  const day = date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `Your ${shown}${rest} briefing for ${day}`;
}

export async function sendNewsletterEmail({
  to,
  articles,
  briefing,
  unsubscribeToken,
  date = new Date(),
}: SendNewsletterInput) {
  const from = process.env.GMAIL_USER;

  if (!from || !process.env.GMAIL_APP_PASSWORD) {
    throw new Error(
      "Gmail credentials not set. Set GMAIL_USER and GMAIL_APP_PASSWORD to send newsletters."
    );
  }

  const base = appUrl();
  const unsubscribeUrl = `${base}/api/unsubscribe?token=${encodeURIComponent(unsubscribeToken)}`;
  const input = {
    articles,
    briefing,
    unsubscribeUrl,
    dashboardUrl: `${base}/dashboard`,
    date,
  };

  const mailOptions: SendMailOptions = {
    from: `"Sendlr" <${from}>`,
    to,
    subject: buildSubject(articles, date),
    html: renderNewsletterHtml(input),
    text: renderNewsletterText(input),
    replyTo: from,
    headers: {
      // RFC 8058. Gmail and Yahoo require bulk senders to offer one-click
      // unsubscribe, and honouring it is one of the strongest signals that
      // keeps mail out of the spam folder. The mailto is the fallback for
      // clients that predate the HTTPS form.
      "List-Unsubscribe": `<${unsubscribeUrl}>, <mailto:${from}?subject=unsubscribe>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      // Marks this as bulk mail, which stops auto-responders and out-of-office
      // replies bouncing back at the sending account.
      Precedence: "bulk",
      "Auto-Submitted": "auto-generated",
    },
  };

  const result = await createTransporter().sendMail(mailOptions);
  console.log(`Newsletter sent to ${to} (${articles.length} stories):`, result.messageId);
  return { success: true, messageId: result.messageId };
}
