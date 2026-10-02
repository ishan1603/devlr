import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { z } from "zod";
import { completeJSON } from "@/lib/ai/router";
import {
  VOICE,
  cleanProse,
  describeIssues,
  fitSubject,
  lintProse,
  lintSubject,
  SUBJECT_MAX_LENGTH,
  type StyleIssue,
} from "@/lib/ai/style";
import { titleTokens } from "@/lib/sources/simhash";
import { tagName } from "@/lib/topics/catalog";
import { countItems, leadStory, type Section } from "@/lib/delivery/issue";
import { guardCopy } from "@/lib/guard/news";

/**
 * The editor: the one model call made per reader, per issue.
 *
 * It writes three short things, a subject line, a preheader and an intro, over
 * content that was selected and summarised without it. It is a small graph:
 *
 *   write -> review -> done
 *              |  ^
 *              v  |
 *            write (once more, with the reviewer's notes)
 *              |
 *              v
 *           fallback (a template, when the model cannot produce clean copy)
 *
 * The reviewer is code, not a model. It applies the style guard and checks the
 * subject is actually about something in the issue. So whatever happens, the
 * text that reaches the inbox has passed the same rules, and an issue is never
 * held up waiting for a model.
 */

export interface EditorInput {
  sections: Section[];
  /** Human-readable interests, e.g. ["Backend", "PostgreSQL"]. Never repo names. */
  interests: string[];
  /** The reader's last few intros, so the opening does not repeat itself. */
  previousIntros: string[];
  /** Issue date, for the fallback copy. */
  date: Date;
}

export interface EditorOutput {
  subject: string;
  preheader: string;
  intro: string;
  aiEdited: boolean;
}

const PREHEADER_MAX = 110;
const INTRO_MAX_WORDS = 55;
const MAX_ATTEMPTS = 2;

const DraftSchema = z.object({
  subject: z.string(),
  preheader: z.string(),
  intro: z.string(),
});
type Draft = z.infer<typeof DraftSchema>;

const EditorState = Annotation.Root({
  input: Annotation<EditorInput>(),
  draft: Annotation<Draft | null>(),
  notes: Annotation<string>(),
  attempts: Annotation<number>(),
  output: Annotation<EditorOutput | null>(),
});

type State = typeof EditorState.State;

const SYSTEM = [
  VOICE,
  "",
  "You are the editor of Devlr, a developer newsletter. You are given the contents of one",
  "issue, already chosen and summarised. Write three things.",
  "",
  `subject: ${SUBJECT_MAX_LENGTH} characters at most. Name the single most important item`,
  "concretely: the product, the version, the number. It may add a second item after a comma.",
  "It must read like one developer telling another what happened. Not a teaser, not a",
  "question, no 'Your weekly digest', no colon-separated label, no title case.",
  "",
  `preheader: ${PREHEADER_MAX} characters at most. It appears next to the subject in the inbox.`,
  "Add something the subject did not say, such as the second and third items.",
  "",
  `intro: one or two sentences, ${INTRO_MAX_WORDS} words at most. Say what ties this issue`,
  "together or why the lead item matters to someone with this reader's interests. Do not",
  "greet the reader, do not say 'this week' or 'in this issue', do not list every item.",
  "",
  "Use only facts from the items provided.",
].join("\n");

function briefFor(input: EditorInput): string {
  const lines: string[] = [];
  if (input.interests.length > 0) lines.push(`READER INTERESTS: ${input.interests.join(", ")}`);

  let n = 0;
  for (const section of input.sections) {
    lines.push("", `## ${section.title}`);
    if (section.type === "stories") {
      for (const item of section.items) {
        lines.push(`${++n}. ${item.title} (${item.source})\n   ${item.summary}`);
      }
    } else if (section.type === "repos") {
      for (const repo of section.repos) {
        lines.push(`${++n}. ${repo.fullName}, ${repo.stars} stars: ${repo.description}`);
      }
    } else if (section.type === "guard") {
      for (const entry of section.entries) {
        lines.push(`${++n}. In ${entry.repo}: ${entry.title}\n   ${entry.action}`);
      }
    } else if (section.type === "eol") {
      for (const entry of section.entries) {
        lines.push(
          `${++n}. ${entry.product} ${entry.cycle} reaches end of life on ${entry.eolDate} ` +
            `(${entry.daysLeft} days from now)`
        );
      }
    } else if (section.type === "learn") {
      lines.push(`${++n}. Learn question: ${section.title}`);
    } else if (section.type === "company_radar") {
      for (const company of section.companies) {
        lines.push(`${++n}. Company update from ${company.name}: ${company.updates.length} new items`);
      }
    } else if (section.type === "release_radar") {
      for (const release of section.releases) {
        lines.push(`${++n}. Release: ${release.package} @ ${release.version}`);
      }
    }
  }

  if (input.previousIntros.length > 0) {
    lines.push("", "DO NOT OPEN LIKE ANY OF THESE EARLIER INTROS:");
    for (const intro of input.previousIntros) lines.push(`- ${intro}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Review (deterministic)
// ---------------------------------------------------------------------------

/** Every meaningful word in the issue, for the grounding check. */
function vocabulary(sections: Section[]): Set<string> {
  const words = new Set<string>();
  const add = (text: string) => titleTokens(text).forEach((t) => words.add(t));
  for (const section of sections) {
    if (section.type === "stories") section.items.forEach((i) => add(`${i.title} ${i.summary} ${i.source}`));
    else if (section.type === "repos") section.repos.forEach((r) => add(`${r.fullName.replace("/", " ")} ${r.description}`));
    else if (section.type === "guard") section.entries.forEach((e) => add(`${e.repo.replace("/", " ")} ${e.title} ${e.action}`));
    else if (section.type === "eol") section.entries.forEach((e) => add(`${e.product} ${e.cycle} end of life`));
    else if (section.type === "learn") add(`${section.title} ${section.question}`);
    else if (section.type === "company_radar") section.companies.forEach(c => add(`${c.name} ${c.updates.map(u => u.title).join(" ")}`));
    else if (section.type === "release_radar") section.releases.forEach(r => add(`${r.package} ${r.version} ${r.notes}`));
  }
  return words;
}

/**
 * A subject has to be about the issue. If fewer than half of its meaningful
 * words appear anywhere in the content, the model has drifted, and a subject
 * that promises something the email does not contain is the fastest way to get
 * marked as spam.
 */
export function isGrounded(subject: string, sections: Section[]): boolean {
  const tokens = titleTokens(subject);
  if (tokens.length === 0) return false;
  const vocab = vocabulary(sections);
  const hits = tokens.filter((t) => vocab.has(t)).length;
  return hits / tokens.length >= 0.5;
}

/** Whole numbers and versions in a piece of text: "18", "5.4", "2026". */
function numbersIn(text: string): string[] {
  return text.match(/\d+(?:\.\d+)*/g) ?? [];
}

/**
 * Numbers in the draft that appear nowhere in the issue.
 *
 * This is where a model's inventions do damage. A reworded headline is
 * harmless; "v5.4" on a release that never said 5.4 is a false statement in
 * the subject line. Every number the editor writes has to be one it was given.
 */
export function inventedNumbers(text: string, sections: Section[]): string[] {
  const source = new Set<string>();
  const add = (value: string | number | undefined) => {
    if (value === undefined) return;
    for (const n of numbersIn(String(value))) {
      source.add(n);
      // "1.90.0" also licenses "1.90" and "1".
      const parts = n.split(".");
      for (let i = 1; i < parts.length; i++) source.add(parts.slice(0, i).join("."));
    }
  };

  for (const section of sections) {
    if (section.type === "stories") {
      section.items.forEach((i) => add(`${i.title} ${i.summary} ${i.meta.join(" ")}`));
    } else if (section.type === "repos") {
      section.repos.forEach((r) => add(`${r.fullName} ${r.description} ${r.stars}`));
    } else if (section.type === "guard") {
      section.entries.forEach((e) => add(`${e.repo} ${e.title} ${e.action} ${e.command ?? ""} ${e.meta.join(" ")}`));
    } else if (section.type === "eol") {
      section.entries.forEach((e) => add(`${e.product} ${e.cycle} ${e.eolDate} ${e.daysLeft} ${e.latest ?? ""}`));
    } else if (section.type === "learn") {
      add(section.title);
    } else if (section.type === "company_radar") {
      section.companies.forEach(c => add(`${c.name}`));
    } else if (section.type === "release_radar") {
      section.releases.forEach(r => add(`${r.package} ${r.version}`));
    }
    // Counting what is in the issue is fine: "three releases", "8 stories".
    add(section.type === "stories" ? section.items.length : section.type === "repos" ? section.repos.length : section.type === "company_radar" ? section.companies.length : section.type === "release_radar" ? section.releases.length : section.type === "learn" ? 1 : section.entries.length);
  }
  add(countItems(sections));

  return numbersIn(text).filter((n) => !source.has(n));
}

export function reviewDraft(draft: Draft, sections: Section[]): { clean: Draft; issues: StyleIssue[]; notes: string } {
  const clean: Draft = {
    subject: cleanProse(draft.subject).replace(/[.]+$/, ""),
    preheader: cleanProse(draft.preheader),
    intro: cleanProse(draft.intro),
  };

  const issues: StyleIssue[] = [
    ...lintSubject(clean.subject),
    ...lintProse(clean.preheader),
    ...lintProse(clean.intro),
  ];
  const notes: string[] = [];
  if (issues.length > 0) notes.push(describeIssues(issues));

  if (clean.preheader.length > PREHEADER_MAX) {
    issues.push({ rule: "too-long", detail: "preheader" });
    notes.push(`The preheader is ${clean.preheader.length} characters, the limit is ${PREHEADER_MAX}.`);
  }
  if (clean.intro.split(/\s+/).length > INTRO_MAX_WORDS) {
    issues.push({ rule: "too-long", detail: "intro" });
    notes.push(`The intro is too long, the limit is ${INTRO_MAX_WORDS} words.`);
  }
  if (clean.subject && !isGrounded(clean.subject, sections)) {
    issues.push({ rule: "empty", detail: "subject not grounded" });
    notes.push("The subject must name something that is actually in the issue.");
  }
  const invented = inventedNumbers(`${clean.subject} ${clean.preheader} ${clean.intro}`, sections);
  if (invented.length > 0) {
    issues.push({ rule: "empty", detail: "invented number" });
    notes.push(
      `These numbers are not in the source material: ${[...new Set(invented)].join(", ")}. ` +
        "Use only versions, dates and figures that appear in the items."
    );
  }
  if (/^(your|this week|weekly|daily|devlr)\b/i.test(clean.subject)) {
    issues.push({ rule: "banned-phrase", detail: "generic subject" });
    notes.push("The subject is generic. Lead with the specific item.");
  }

  return { clean, issues, notes: notes.join(" ") };
}

// ---------------------------------------------------------------------------
// Fallback (deterministic)
// ---------------------------------------------------------------------------

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * Copy written by a template. Used when no model is configured, when every
 * provider is out of budget, and when the model's drafts fail review twice. It
 * is plain, but it is specific, because it is built from the lead item.
 */
export function templateCopy(input: EditorInput): EditorOutput {
  const lead = leadStory(input.sections);
  const total = countItems(input.sections);
  const topics = input.interests.slice(0, 3);

  let subject: string;
  let preheader: string;
  let intro: string;

  if (lead) {
    subject = fitSubject(lead.title);
    const others = input.sections
      .flatMap((s) => (s.type === "stories" ? s.items : []))
      .filter((i) => i.ref !== lead.ref)
      .slice(0, 2)
      .map((i) => i.title);
    preheader = others.length > 0 ? `Also: ${others.join("; ")}` : lead.summary;
    intro =
      total > 1
        ? `${total} things worth your time${topics.length ? ` across ${joinList(topics)}` : ""}. Start with the first one.`
        : lead.summary;
  } else {
    const first = input.sections[0];
    if (first?.type === "guard") {
      ({ subject, preheader, intro } = guardCopy(first, false));
    } else if (first?.type === "eol") {
      const e = first.entries[0];
      subject = fitSubject(`${e.product} ${e.cycle} reaches end of life in ${Math.max(0, e.daysLeft)} days`);
      preheader = "Lifecycle dates for the versions in your stack.";
      intro = "Support windows are closing on versions in your stack. The dates are below.";
    } else if (first?.type === "repos") {
      subject = fitSubject(`${first.repos[0].fullName} and ${first.repos.length - 1} more new repos`);
      preheader = first.repos[0].description;
      intro = "New repositories that picked up stars fast in the languages you use.";
    } else {
      subject = "Your Devlr issue";
      preheader = "";
      intro = "";
    }
  }

  return {
    subject,
    preheader: cleanProse(preheader).slice(0, PREHEADER_MAX),
    intro: cleanProse(intro),
    aiEdited: false,
  };
}

// ---------------------------------------------------------------------------
// The graph
// ---------------------------------------------------------------------------

async function write(state: State): Promise<Partial<State>> {
  const retry = state.attempts > 0;
  const result = await completeJSON({
    task: "editor",
    system: SYSTEM,
    prompt: retry
      ? `${briefFor(state.input)}\n\nYOUR LAST DRAFT WAS REJECTED. Fix this and write all three again:\n${state.notes}`
      : briefFor(state.input),
    schema: DraftSchema,
    temperature: retry ? 0.5 : 0.7,
    maxTokens: 500,
    version: "editor-v1",
    // A rewrite must be a fresh call, or the cache would hand back the draft
    // that was just rejected.
    cache: !retry,
  });

  return { draft: result?.data ?? null, attempts: state.attempts + 1 };
}

function review(state: State): Partial<State> {
  if (!state.draft) return { notes: "no draft" };

  const { clean, issues, notes } = reviewDraft(state.draft, state.input.sections);
  if (issues.length === 0) {
    return { output: { ...clean, aiEdited: true }, notes: "" };
  }
  return { notes };
}

function fallback(state: State): Partial<State> {
  return { output: templateCopy(state.input) };
}

function afterReview(state: State): "done" | "write" | "fallback" {
  if (state.output) return "done";
  // No draft means no provider answered. Asking again will not change that.
  if (!state.draft) return "fallback";
  return state.attempts < MAX_ATTEMPTS ? "write" : "fallback";
}

const graph = new StateGraph(EditorState)
  .addNode("write", write)
  .addNode("review", review)
  .addNode("fallback", fallback)
  .addEdge(START, "write")
  .addEdge("write", "review")
  .addConditionalEdges("review", afterReview, { done: END, write: "write", fallback: "fallback" })
  .addEdge("fallback", END)
  .compile();

export async function editIssue(input: EditorInput): Promise<EditorOutput> {
  try {
    const final = await graph.invoke({ input, draft: null, notes: "", attempts: 0, output: null });
    return final.output ?? templateCopy(input);
  } catch (err) {
    // The editor is an enhancement. Any failure in it degrades to the template
    // rather than failing the send.
    console.error("[editor] graph failed, using template copy:", err);
    return templateCopy(input);
  }
}

export function interestNames(domains: string[], stack: string[]): string[] {
  return [...stack, ...domains].map(tagName);
}
