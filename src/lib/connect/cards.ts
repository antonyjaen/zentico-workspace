// Compact chat cards for connected-app items (GitHub issues/PRs, Jira issues, Notion pages),
// built from provider data and run through the same validation as app cards (lib/chat/cards).
// Server-only (pure).
import type { BotCard } from "@/app/(apps)/chat/shared";
import { parseCards } from "../chat/cards";

/** Markdown-lite special characters in provider data are shown literally. */
const esc = (s: string) => s.replace(/([*_~`[\]\\])/g, "\\$1");

function card(c: { title: string; subtitle: string; text?: string; button: { text: string; url: string | null } }): BotCard | null {
  const [out] = parseCards({
    cards: [
      {
        title: c.title,
        subtitle: c.subtitle,
        ...(c.text ? { text: c.text } : {}),
        ...(c.button.url ? { buttons: [{ text: c.button.text, url: c.button.url }] } : {}),
      },
    ],
  });
  return out ?? null;
}

export function githubCard(i: {
  repo: string;
  number: number;
  title: string;
  state: string;
  isPullRequest: boolean;
  draft?: boolean;
  author: string | null;
  assignees: string[];
  labels?: string[];
  url: string;
}): BotCard | null {
  const people = [i.author ? `@${esc(i.author)}` : "", i.assignees.length ? `→ ${i.assignees.map((a) => `@${esc(a)}`).join(", ")}` : ""].filter(Boolean).join(" ");
  const labels = (i.labels ?? []).slice(0, 5).map((l) => `\`${l.replace(/`/g, "'")}\``).join(" ");
  return card({
    title: i.title,
    subtitle: `${i.repo}#${i.number} · ${i.isPullRequest ? "Pull request" : "Issue"} · ${i.draft ? "draft" : i.state}`,
    text: [people, labels].filter(Boolean).join(" · ") || undefined,
    button: { text: "GitHub", url: i.url },
  });
}

export function jiraCard(i: { key: string; summary: string; status: string; type: string; assignee: string | null; priority: string | null; url: string | null }): BotCard | null {
  return card({
    title: i.summary,
    subtitle: [i.key, i.type, i.status].filter(Boolean).join(" · "),
    text: [i.assignee ? `→ ${esc(i.assignee)}` : "", i.priority ? esc(i.priority) : ""].filter(Boolean).join(" · ") || undefined,
    button: { text: "Jira", url: i.url },
  });
}

export function notionCard(p: { title: string; url: string; lastEdited: string }): BotCard | null {
  return card({
    title: p.title,
    subtitle: `Notion${p.lastEdited ? ` · ${p.lastEdited.slice(0, 10)}` : ""}`,
    button: { text: "Notion", url: p.url },
  });
}
