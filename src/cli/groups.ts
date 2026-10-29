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
import {
  FORBIDDEN_FLAGS,
  forbiddenKeyMessage,
  loadGroups,
  mergeGroups,
  thinGroup,
  type GroupFilter,
} from "../core/groups";
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

/**
 * The filter fields the command line actually chose, as a group fragment.
 * `chaff groups set NAME --scam --type channel` saves exactly what the same
 * flags would have filtered with, which is why the flag table is the only
 * validation this verb needs.
 *
 * The checks run on what the user TYPED, not on the thinned fragment. That
 * order is the whole point: `thinGroup` keeps only the 15 allowed fields, so a
 * `--exclude` would vanish into a fragment that looks clean, the verb would
 * report success, and the user would believe an exclusion was saved when nothing
 * of the kind happened. A refusal has to name the flag it refused.
 *
 * Returns the refusal as a string when nothing was typed: a `set` that stored an
 * empty fragment would look like a group that matches everything, which is the
 * opposite of what the user meant.
 */
export function fragmentFromArgs(ctx: CommandContext): { fragment: GroupFilter } | string {
  if (ctx.args.groupNames.length > 0) {
    return (
      "groups set does not fold in other groups: name the fields you want, or " +
      "edit the two groups by hand"
    );
  }
  for (const [flag, field] of FORBIDDEN_FLAGS) {
    if (ctx.args.provided.has(flag)) return forbiddenKeyMessage(field);
  }
  const fragment = thinGroup(ctx.args.filters);
  if (Object.keys(fragment).length === 0) {
    return "groups set needs at least one filter flag, for example: chaff groups set junk --scam";
  }
  return { fragment };
}
