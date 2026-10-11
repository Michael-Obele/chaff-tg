import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Column, Table } from "../src/cli/render/columns";
import { renderCsv } from "../src/cli/render/csv";
import { renderJson } from "../src/cli/render/json";
import { renderMd } from "../src/cli/render/md";
import { renderTable } from "../src/cli/render/table";
import { parseArgs } from "../src/cli/args";
import {
  emitOutput,
  noteOutput,
  outputFormat,
  renderOutput,
  verboseOutput,
} from "../src/cli/output";

/**
 * The same three rows go through all four renderers, so the formats differ in
 * presentation only. One title carries a pipe: the markdown escape has to hold.
 */
interface Row {
  id: number;
  title: string;
  members: number | null;
  flag: string;
}

const ROWS: Row[] = [
  { id: -1001234567890, title: "Big | Signals Premium", members: 4821, flag: "SCAM" },
  { id: -1009876543210, title: "VIP Pump Room", members: 812, flag: "SCAM" },
  { id: -1005555555555, title: "Rust Nigeria", members: null, flag: "" },
];

const COLUMNS: Array<Column<Row>> = [
  { key: "id", header: "id", align: "right", value: (row) => String(row.id) },
  { key: "title", header: "Title", value: (row) => row.title },
  {
    key: "members",
    header: "Members",
    align: "right",
    value: (row) => (row.members === null ? "-" : String(row.members)),
  },
  { key: "flag", header: "Flags", value: (row) => row.flag },
];

const TABLE: Table<Row> = { columns: COLUMNS, rows: ROWS };

describe("renderTable", () => {
  test("prints a header row and one line per row", () => {
    const lines = renderTable(TABLE).split("\n");
    expect(lines.at(-1)).toBe("");
    expect(lines.slice(0, -1)).toHaveLength(4);
    expect(lines[0]).toContain("Title");
    expect(lines[1]).toContain("Big | Signals Premium");
    expect(lines[3]).toContain("Rust Nigeria");
  });

  test("right-aligns a numeric column and prints a missing count as a dash", () => {
    const lines = renderTable(TABLE).split("\n");
    expect(lines[0]).toContain("   id");
    expect(lines[3]).toContain("-");
  });

  test("an empty table is just the header", () => {
    expect(renderTable({ columns: COLUMNS, rows: [] })).toBe("id  Title  Members  Flags\n");
  });
});

describe("renderJson", () => {
  test("prints one object per row, with keys in column order", () => {
    const parsed = JSON.parse(renderJson(TABLE)) as Array<Record<string, unknown>>;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(3);
    expect(Object.keys(parsed[0] ?? {})).toEqual(["id", "title", "members", "flag"]);
  });

  test("keeps the raw value's type, so a missing count stays null", () => {
    const parsed = JSON.parse(renderJson(TABLE)) as Array<Record<string, unknown>>;
    expect(parsed[0]?.id).toBe(-1001234567890);
    expect(parsed[2]?.members).toBeNull();
  });

  test("key order is stable across two renders", () => {
    expect(renderJson(TABLE)).toBe(renderJson(TABLE));
  });

  test("an empty table is an empty array", () => {
    expect(renderJson({ columns: COLUMNS, rows: [] })).toBe("[]\n");
  });
});

describe("renderCsv", () => {
  test("starts with a header row", () => {
    const lines = renderCsv(TABLE).split("\n");
    expect(lines[0]).toBe("id,Title,Members,Flags");
    expect(lines.slice(0, -1)).toHaveLength(4);
  });

  test("quotes a field that contains a comma, a quote or a newline", () => {
    const table: Table<{ text: string }> = {
      columns: [{ key: "text", header: "text", value: (row) => row.text }],
      rows: [{ text: "a,b" }, { text: 'say "hi"' }, { text: "one\ntwo" }],
    };
    expect(renderCsv(table)).toBe('text\n"a,b"\n"say ""hi"""\n"one\ntwo"\n');
  });
});

describe("renderMd", () => {
  test("prints a markdown table with a divider row", () => {
    const lines = renderMd(TABLE).split("\n");
    expect(lines[0]).toBe("| id | Title | Members | Flags |");
    expect(lines[1]).toBe("| --- | --- | --- | --- |");
    expect(lines.slice(0, -1)).toHaveLength(5);
  });

  test("escapes a pipe inside a cell so the table cannot break", () => {
    expect(renderMd(TABLE)).toContain("Big \\| Signals Premium");
  });

  test("escapes a pipe in a header too", () => {
    const table: Table<{ text: string }> = {
      columns: [{ key: "text", header: "a|b", value: (row) => row.text }],
      rows: [{ text: "x" }],
    };
    expect(renderMd(table)).toBe("| a\\|b |\n| --- |\n| x |\n");
  });
});

describe("outputFormat and renderOutput", () => {
  test("--json, --csv and --md choose their format; otherwise a table", () => {
    expect(outputFormat({ json: true, csv: false, md: false, out: null })).toBe("json");
    expect(outputFormat({ json: false, csv: true, md: false, out: null })).toBe("csv");
    expect(outputFormat({ json: false, csv: false, md: true, out: null })).toBe("md");
    expect(outputFormat({ json: false, csv: false, md: false, out: null })).toBe("table");
  });

  test("renderOutput dispatches to all four renderers", () => {
    expect(renderOutput("table", TABLE)).toBe(renderTable(TABLE));
    expect(renderOutput("json", TABLE)).toBe(renderJson(TABLE));
    expect(renderOutput("csv", TABLE)).toBe(renderCsv(TABLE));
    expect(renderOutput("md", TABLE)).toBe(renderMd(TABLE));
  });
});

describe("emitOutput and noteOutput", () => {
  test("writes stdout and, with --out, the same bytes to a file", () => {
    const stdout = sink();
    const file = join(mkdtempSync(join(tmpdir(), "chaff-out-")), "cleanup.md");
    const body = renderMd(TABLE);
    emitOutput(stdout, file, body);
    expect(stdout.text()).toBe(body);
    expect(readFileSync(file, "utf8")).toBe(body);
  });

  test("without --out nothing is written to disk", () => {
    const stdout = sink();
    emitOutput(stdout, null, "hello\n");
    expect(stdout.text()).toBe("hello\n");
  });

  test("noteOutput is silent under --quiet", () => {
    const streams = { stdout: sink(), stderr: sink() };
    noteOutput("table", streams, { quiet: true }, "Found 37 chats\n");
    expect(streams.stdout.text()).toBe("");
    noteOutput("table", streams, { quiet: false }, "Found 37 chats\n");
    expect(streams.stdout.text()).toBe("Found 37 chats\n");
  });
});

/**
 * A machine format promises stdout is the payload and nothing else, so the
 * human chatter has to move to stderr. These tests drive the same two writers
 * a command gets, through the same flag parse a command gets.
 */
describe("chatter stays off the machine payload", () => {
  test("with --json -v stdout parses as JSON and the verbose line is on stderr", () => {
    const args = parseArgs(["--json", "-v", "list"]);
    const stdout = sink();
    const stderr = sink();

    emitOutput(stdout, null, renderJson(TABLE));
    verboseOutput(outputFormat(args.flags), { stdout, stderr }, args.flags, "leaving -1001\n");

    expect(JSON.parse(stdout.text())).toHaveLength(3);
    expect(stderr.text()).toBe("leaving -1001\n");
  });

  test("under --csv a note goes to stderr and the payload is untouched", () => {
    const args = parseArgs(["--csv", "list"]);
    const stdout = sink();
    const stderr = sink();

    emitOutput(stdout, null, renderCsv(TABLE));
    noteOutput(outputFormat(args.flags), { stdout, stderr }, args.flags, "Found 3 chats\n");

    expect(stdout.text()).toBe(renderCsv(TABLE));
    expect(stderr.text()).toBe("Found 3 chats\n");
  });

  test("without a machine format the table and -v still share stdout", () => {
    const args = parseArgs(["-v", "list"]);
    const stdout = sink();
    const stderr = sink();

    emitOutput(stdout, null, renderTable(TABLE));
    verboseOutput(outputFormat(args.flags), { stdout, stderr }, args.flags, "leaving -1001\n");

    expect(stdout.text()).toBe(renderTable(TABLE) + "leaving -1001\n");
    expect(stderr.text()).toBe("");
  });

  test("--quiet silences a note even on the machine format's stderr", () => {
    const args = parseArgs(["--json", "--quiet", "list"]);
    const stdout = sink();
    const stderr = sink();

    noteOutput(outputFormat(args.flags), { stdout, stderr }, args.flags, "Found 3 chats\n");

    expect(stderr.text()).toBe("");
  });
});

interface Sink {
  write(s: string): unknown;
  text(): string;
}

function sink(): Sink {
  const parts: string[] = [];
  return {
    write(chunk: string) {
      parts.push(chunk);
      return true;
    },
    text() {
      return parts.join("");
    },
  };
}
