import nodemailer, { type SendMailOptions, type Transporter } from "nodemailer";
import { renderIssueHtml, renderIssueText } from "@/lib/email/render";
import { appUrl } from "@/lib/delivery/tokens";
import type { Issue } from "@/lib/delivery/issue";

/**
 * Sending an issue.
 *
 * Transports are tried in order. Gmail SMTP is the zero-cost default and caps
 * out near 500 recipients a day; a generic SMTP provider (Brevo, Resend, SES)
 * slots in ahead of it by setting SMTP_HOST, which needs a domain you own.
 */

interface Sender {
  name: string;
  from: string;
  transporter: Transporter;
}

function senders(): Sender[] {
  const out: Sender[] = [];

  if (process.env.SMTP_HOST) {
    out.push({
      name: "smtp",
      from: process.env.SMTP_FROM || process.env.SMTP_USER || process.env.GMAIL_USER || "",
      transporter: nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT ?? 587),
        secure: process.env.SMTP_SECURE === "true",
        auth: process.env.SMTP_USER
          ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
          : undefined,
      }),
    });
  }

  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
    out.push({
      name: "gmail",
      from: process.env.GMAIL_USER,
      transporter: nodemailer.createTransport({
        service: "gmail",
        auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
      }),
    });
  }

  return out.filter((s) => s.from);
}

export function mailConfigured(): boolean {
  return senders().length > 0;
}

export interface SendIssueInput {
  to: string;
  issue: Issue;
  webToken: string;
  unsubscribeToken: string;
  feedToken?: string;
}

export function issueLinks(input: Pick<SendIssueInput, "webToken" | "unsubscribeToken" | "feedToken">) {
  const base = appUrl();
  return {
    web: `${base}/issue/${input.webToken}`,
    preferences: `${base}/app/settings`,
    // The API route, not the page: this URL is also what List-Unsubscribe
    // points at, and mailbox providers POST to it directly.
    unsubscribe: `${base}/api/unsubscribe?token=${encodeURIComponent(input.unsubscribeToken)}`,
    feed: input.feedToken ? `${base}/feed/${input.feedToken}` : undefined,
  };
}

export async function sendIssueEmail(input: SendIssueInput) {
  const available = senders();
  if (available.length === 0) {
    throw new Error(
      "No mail transport configured. Set GMAIL_USER and GMAIL_APP_PASSWORD, or SMTP_HOST. See SETUP.md."
    );
  }

  const links = issueLinks(input);
  const html = await renderIssueHtml({ issue: input.issue, links, recipient: input.to });
  const text = renderIssueText({ issue: input.issue, links });

  const errors: string[] = [];
  for (const sender of available) {
    const message: SendMailOptions = {
      from: `"Devlr" <${sender.from}>`,
      to: input.to,
      subject: input.issue.subject,
      html,
      text,
      replyTo: sender.from,
      headers: {
        // RFC 8058. Gmail and Yahoo require bulk senders to offer one-click
        // unsubscribe, and honouring it is one of the strongest signals for
        // staying out of the spam folder. The mailto is the fallback for
        // clients that predate the HTTPS form.
        "List-Unsubscribe": `<${links.unsubscribe}>, <mailto:${sender.from}?subject=unsubscribe>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        // Marks this as bulk mail, which stops out-of-office replies bouncing
        // back at the sending account.
        Precedence: "bulk",
        "Auto-Submitted": "auto-generated",
        "X-Entity-Ref-ID": input.webToken,
      },
    };

    try {
      const result = await sender.transporter.sendMail(message);
      return { provider: sender.name, messageId: result.messageId as string };
    } catch (err) {
      errors.push(`${sender.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(`All mail transports failed. ${errors.join(" | ")}`);
}
