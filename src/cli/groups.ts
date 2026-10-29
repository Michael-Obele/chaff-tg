/**
 * Folding `--group` into the filters a run uses (`plan/groups.md`, "How a group
 * reaches the filter").
 *
 * This is a CLI-edge job, not a core one. `src/core/filters.ts` stays a pure
 * function over `Filters`; the manifest keeps recording plain fields in
 * `filters` and plain `why` tokens. Two consequences matter more than the
 * tidiness:
 *
 * - a manifest written with `--group` replays on a machine with no
 *   `groups.json`, which is the property the review step exists for;
 * - a chat is explained by the field that pulled it in (`keyword:amazon`,
 *   `scam`), not by the name of a list the reader would have to go and open.
 *
 * The merge rules themselves live in `mergeGroups` (src/core/groups.ts), shared
 * by this path and the `set` verb, so the two cannot disagree about what a
 * group means.
 *
 * `resolvePaths` is used rather than `resolveLocalState`: the file lives in the
 * config directory, which no config value moves, so this reads no `config.json`
 * and cannot fail because of one.
 */
import { loadGroups, mergeGroups } from "../core/groups";
import { resolvePaths } from "../core/session";
import type { Filters } from "../core/types";
import type { CommandContext } from "./index";

/**
 * The filters this run should use: what was typed, with the named groups
 * folded in. No flag, no file read.
 */
export function applyGroups(ctx: CommandContext): Filters {
  if (ctx.args.groupNames.length === 0) return ctx.args.filters;
  const groups = loadGroups(resolvePaths(ctx.env).groupsPath());
  return mergeGroups(groups, ctx.args.groupNames, ctx.args.filters, ctx.args.provided);
}
