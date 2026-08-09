import { sanitizeTerminalText } from "./terminal-text.js";

export type MarkdownBlock =
  | { readonly type: "heading"; readonly level: number; readonly text: string }
  | { readonly type: "bullet"; readonly text: string }
  | { readonly type: "quote"; readonly text: string }
  | { readonly type: "code"; readonly language?: string; readonly text: string }
  | { readonly type: "table"; readonly rows: readonly (readonly string[])[] }
  | { readonly type: "text"; readonly text: string };

export function parseSafeMarkdown(source: string): MarkdownBlock[] {
  const lines = sanitizeTerminalText(source).split("\n");
  const blocks: MarkdownBlock[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index] ?? "";
    const fence = /^```([^`]*)$/.exec(line.trim());
    if (fence) {
      const code: string[] = [];
      index++;
      while (index < lines.length && !(lines[index] ?? "").trim().startsWith("```")) {
        code.push(lines[index] ?? "");
        index++;
      }
      if (index < lines.length) index++;
      blocks.push({
        type: "code",
        ...(fence[1]?.trim() ? { language: fence[1].trim() } : {}),
        text: code.join("\n"),
      });
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1]!.length, text: heading[2]! });
      index++;
      continue;
    }
    const bullet = /^\s*(?:[-*+] |\d+[.)] )(.+)$/.exec(line);
    if (bullet) {
      blocks.push({ type: "bullet", text: bullet[1]! });
      index++;
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      blocks.push({ type: "quote", text: quote[1]! });
      index++;
      continue;
    }
    if (line.trim().startsWith("|") && line.trim().endsWith("|")) {
      const rows: string[][] = [];
      while (index < lines.length) {
        const tableLine = (lines[index] ?? "").trim();
        if (!tableLine.startsWith("|") || !tableLine.endsWith("|")) break;
        const cells = tableLine.slice(1, -1).split("|").map((cell) => cell.trim());
        if (!cells.every((cell) => /^:?-{3,}:?$/.test(cell))) rows.push(cells);
        index++;
      }
      blocks.push({ type: "table", rows });
      continue;
    }
    if (line.trim()) blocks.push({ type: "text", text: line });
    index++;
  }
  return blocks;
}
