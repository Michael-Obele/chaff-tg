/**
 * The interactive checklist and the final confirmation: the two gates between
 * a reviewed plan and a destructive run
 * (plan/cli.md, "The interactive checklist"; plan/safety.md, "Reviewed before
 * destructive").
 *
 * Both functions take their I/O as an argument (`{ input, output }`) rather
 * than reading the ambient process, so the same code drives a real terminal
 * and a scripted test stream, and neither ever touches stdout itself.
 *
 * The protocol is line based, one command per line, which is the lazy shape
 * that works identically for a person at a terminal and for a scripted input
 * stream in a test:
 *
 * - the checklist renders the chats with `[x]`/`[ ]` boxes and reads a line:
 *   empty confirms the current selection, `q` quits (`null`), `a` selects all
 *   (and clears all when everything is ticked), and a row number toggles that
 *   row. The input ending unconfirmed is a quit: a checklist that ran out of
 *   pipe must not confirm itself.
 * - the confirmation names the count, the pace and the estimate, then asks for
 *   the word `leave` when more than 20 chats are selected (plan/cli.md), and
 *   accepts an Enter for 20 or fewer.
 *
 * Pre-selections are the caller's decision, carried in each item: the leave
 * command pre-ticks Telegram's own scam flag and never pre-ticks a pinned
 * chat. This module only honours what it is given.
 */
import { createInterface } from "node:readline";
import type { Table } from "./render/columns";
import { renderTable } from "./render/table";

/** One chat as the checklist shows it. */
export interface ChecklistItem {
  id: number;
  title: string;
  type: string;
  members: number | null;
  lastMessageAt: string | null;
  scam: boolean;
  /** Ticked before the user touches anything (the leave command: scam chats). */
  preselected: boolean;
}

/** The scripted or real streams an interactive step reads and writes. */
export interface ChecklistIo {
  /** A readable of text lines; absent means no input, which quits immediately. */
  input?: unknown;
  /** Anything with `write`; absent renders nowhere. */
  output?: unknown;
}

/** Above this many selected chats, confirming means typing the word `leave`. */
export const TYPED_CONFIRM_MIN = 20;

/** The word that confirms a large run, and nothing else. */
const CONFIRM_WORD = "leave";

/** Where the rendered text goes, or a no-op when the caller supplied none. */
function writer(io: ChecklistIo): (text: string) => void {
  const output = io.output as { write(s: string): unknown } | undefined;
  return (text) => {
    output?.write(text);
  };
}

/** Every line the input yields, or none of it when there is no input. */
async function* lines(input: unknown): AsyncGenerator<string> {
  if (input === undefined || input === null) return;
  const rl = createInterface({ input: input as Parameters<typeof createInterface>[0]["input"] });
  try {
    for await (const line of rl) yield line;
  } finally {
    rl.close();
  }
}

/** The display row behind one checklist line. */
interface ChecklistRow {
  box: string;
  number: string;
  title: string;
  type: string;
  members: string;
  last: string;
  flag: string;
}

/** The checklist table: the same columns every render, boxes included. */
const CHECKLIST_COLUMNS = [
  { key: "box", header: "", value: (row: ChecklistRow) => row.box },
  { key: "number", header: "", value: (row: ChecklistRow) => row.number },
  { key: "title", header: "chat", value: (row: ChecklistRow) => row.title },
  { key: "type", header: "type", value: (row: ChecklistRow) => row.type },
  {
    key: "members",
    header: "members",
    align: "right" as const,
    value: (row: ChecklistRow) => row.members,
  },
  { key: "last", header: "last", value: (row: ChecklistRow) => row.last },
  { key: "flag", header: "", value: (row: ChecklistRow) => row.flag },
];

/** Show the chats, the selection count and the commands, ending with a newline. */
function renderChecklist(items: ChecklistItem[], selected: ReadonlySet<number>): string {
  const rows: ChecklistRow[] = items.map((item, index) => ({
    box: selected.has(item.id) ? "[x]" : "[ ]",
    number: String(index + 1),
    title: item.title,
    type: item.type,
    members: item.members === null ? "-" : String(item.members),
    last: item.lastMessageAt === null ? "-" : item.lastMessageAt.slice(0, 10),
    flag: item.scam ? "SCAM" : "",
  }));
  const table: Table<ChecklistRow> = { columns: CHECKLIST_COLUMNS, rows };
  const footer =
    `${selected.size} of ${items.length} selected. ` +
    "Enter to confirm, q to quit, a to select all, a number toggles that chat.\n";
  return `${renderTable(table)}${footer}`;
}

/**
 * Show the checklist and return the selected ids in item order, or `null` when
 * the user quit (or the input ended unconfirmed).
 */
export async function runChecklist(
  items: ChecklistItem[],
  io: ChecklistIo,
): Promise<number[] | null> {
  const write = writer(io);
  const selected = new Set(items.filter((item) => item.preselected).map((item) => item.id));
  const order = new Map(items.map((item, index) => [item.id, index]));

  write(renderChecklist(items, selected));
  for await (const line of lines(io.input)) {
    const command = line.trim();

    if (command === "") {
      return [...selected].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    }
    if (command === "q") return null;
    if (command === "a") {
      // Select all, or clear all when everything is already ticked: the
      // header-checkbox behavior, not an invert (an invert from the scam
      // pre-selection would read as "everything except the scams").
      if (selected.size === items.length) selected.clear();
      else for (const item of items) selected.add(item.id);
      write(renderChecklist(items, selected));
      continue;
    }

    const number = /^\d+$/.test(command) ? Number.parseInt(command, 10) : 0;
    const item = items[number - 1];
    if (item !== undefined) {
      if (selected.has(item.id)) selected.delete(item.id);
      else selected.add(item.id);
      write(renderChecklist(items, selected));
      continue;
    }
    write(`unknown command ${JSON.stringify(command)}; Enter confirms, q quits.\n`);
  }
  return null;
}

/** What the final screen names before anything is touched. */
export interface ConfirmSummary {
  /** How many chats the run is about to leave. */
  count: number;
  /** The base pause between leaves, in milliseconds. */
  paceMs: number;
  /** The whole run at that pace, in seconds. */
  estimateSeconds: number;
}

/**
 * Name the count, the pace and the estimate, then ask.
 *
 * Above {@link TYPED_CONFIRM_MIN} chats the only answer is the typed word
 * `leave`; 20 or fewer confirm on Enter (or `y`) and cancel on anything else,
 * including the input ending.
 */
export async function runConfirm(summary: ConfirmSummary, io: ChecklistIo): Promise<boolean> {
  const write = writer(io);
  write(
    `About to leave ${summary.count} chats, about ${summary.paceMs}ms apart, ` +
      `about ${summary.estimateSeconds}s in total.\n`,
  );

  if (summary.count > TYPED_CONFIRM_MIN) {
    write(`Type ${CONFIRM_WORD} to confirm: `);
    for await (const line of lines(io.input)) return line.trim() === CONFIRM_WORD;
    return false;
  }

  write("Press Enter to confirm, q to cancel: ");
  for await (const line of lines(io.input)) {
    const answer = line.trim().toLowerCase();
    return answer === "" || answer === "y";
  }
  return false;
}
