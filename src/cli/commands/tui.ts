/**
 * `chaff tui`: the command shell. The full-screen OpenTUI interface is NOT
 * part of this build (Task 15 is deferred). This file is the seam Task 15
 * will use: `runLeave(plan, opts, onProgress)` from `src/core/leave.ts`.
 *
 * When stdout is a TTY and `--json`/`--plain`/`TERM=dumb` are absent, Task 15
 * will dispatch to `openTui()` from `src/tui`. Until then, this prints one
 * honest plain line pointing at `chaff list` / `chaff report` / `chaff leave`.
 *
 * Do not import OpenTUI and do not create `src/tui/` in this task.
 */
import { EXIT } from "../../core/errors";
import type { Command } from "../index";

export const tuiCommand: Command = {
  name: "tui",
  summary: "Print a note: the full screen interface is not in this build",

  async run(ctx) {
    ctx.out.note(
      "the full-screen interface is not in this build; use chaff list, chaff report, and chaff leave instead\n",
    );
    return EXIT.OK;
  },
};
