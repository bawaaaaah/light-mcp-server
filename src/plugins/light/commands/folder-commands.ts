/**
 * Look folders: the looks' `dossier:` tag (show/folders.ts) created, moved, renamed, disbanded and nested.
 * Part of the show commands (show-commands.ts registers them all, with the scope they share: show-command-scope.ts).
 */
import { z } from "zod";
import type { CommandContext } from "./registry.js";
import type { Look } from "../show/model.js";
import { folderOf, inTree, isReservedFolder, nestOf, normalizeFolder, renamedPath, withFolder } from "../show/folders.js";
import { say } from "../../../core/lang.js";
import type { ShowCommandScope } from "./show-command-scope.js";
import type { LookCommands } from "./look-commands.js";

export function registerFolderCommands(common: ShowCommandScope, { checkLook, sameTags }: Pick<LookCommands, "checkLook" | "sameTags">): void {
  const { reg, show } = common;
  // ---- folders: the looks' `dossier:` tag (show/folders.ts), not an object of its own — a folder
  // born from tags lives as long as its looks; one named ahead (show.folder.create) stays, stored
  // with the show's settings. Every look goes through look.put (its checks and history apply), all of
  // them checked first: a look that no longer passes refuses the whole command before any write.
  /** A folder named as it already is (a command's source): any existing name, « Sans dossier » of an older show included, so it can still be renamed or disbanded. */
  const folderSource = z
    .string()
    .trim()
    .min(1)
    .max(100)
    // slashes at the ends and empty segments are simply dropped (« /X/ » is « X »); what is left must name a folder
    .refine((v) => normalizeFolder(v) !== "", { error: () => say("un nom de dossier ne peut pas être vide", "a folder name cannot be empty") })
    .transform(normalizeFolder)
    .describe("a folder name or path (« Famille/Sous-dossier »)");
  /** A folder a command files looks into or names: not under « Sans dossier », which the list keeps for the looks filed nowhere. */
  const folderName = folderSource
    .refine((v) => !isReservedFolder(v), { error: () => say("« Sans dossier » désigne déjà les looks rangés nulle part : choisir un autre nom", "“No folder” already names the looks filed nowhere: choose another name") })
    .describe("a folder name or path (« Famille/Sous-dossier »), free to create");
  /** Every look in the folder `name`, its whole sub-tree included. */
  const underFolder = (name: string) => show.looks.list().filter((l) => inTree(l.tags, name));
  const setNamedFolders = (next: string[]) => show.saveSettings({ folders: [...new Set(next)].sort((a, b) => a.localeCompare(b)) });
  /** Files each look in its new folder (undefined: « sans dossier »): every look checked first, then only the ones that change written. */
  const refile = async (moves: { look: Look; folder: string | undefined }[], ctx: CommandContext) => {
    const changed = moves.map(({ look, folder }) => ({ ...look, tags: withFolder(look.tags, folder) })).filter((l, i) => !sameTags(l.tags, moves[i]!.look.tags));
    for (const l of changed) {
      try {
        checkLook(l);
      } catch (err) {
        // which look holds the whole folder back: without its name, an orphan look is a needle in the folder
        const why = (err as Error).message;
        throw new Error(say(`« ${l.name} » (${l.id}) : ${why}`, `“${l.name}” (${l.id}): ${why}`));
      }
    }
    for (const l of changed) await reg.invoke("look.put", { look: l }, ctx);
    return moves.length;
  };
  const moveThroughLookPut = (looks: Look[], folder: string | undefined, ctx: CommandContext) => refile(looks.map((look) => ({ look, folder })), ctx);
  reg.register({
    name: "show.folder.create",
    title: "Créer un dossier",
    titleEn: "Create a folder",
    hints: "I",
    description: "Names a folder ahead: it exists empty until a look moves into it, and until show.folder.delete dissolves it (a folder only born from looks' tags lives as long as they do).",
    right: "show:write",
    profiles: ["design"],
    schema: z.object({ folder: folderName }),
    run: ({ folder }) => {
      setNamedFolders([...show.settings.folders, folder]);
      return { created: folder };
    },
  });
  reg.register({
    name: "show.folder.move",
    title: "Déplacer des looks",
    titleEn: "Move looks",
    hints: "I",
    description: "Puts whole looks (read here, so their steps and raw channels keep) in one folder: the `dossier:` tag of each one is rewritten. Without a folder name, back « sans dossier ».",
    right: "show:write",
    profiles: ["design"],
    schema: z.object({ ids: z.array(z.string()).min(1).describe("looks to move, whole unknown ids refused before any write"), folder: folderName.optional() }),
    run: async ({ ids, folder }, ctx) => {
      const looks = [...new Set(ids)].map((i) => {
        const l = show.looks.get(i);
        if (!l) throw new Error(say(`look inconnu : ${i}`, `unknown look: ${i}`));
        return l;
      });
      return { moved: await moveThroughLookPut(looks, folder, ctx) };
    },
  });
  reg.register({
    name: "show.folder.rename",
    title: "Renommer un dossier",
    titleEn: "Rename a folder",
    hints: "I",
    description: "Renames the `dossier:` tag of every look of the folder, its sub-folders included (their path keeps its tail); renaming onto an existing folder merges the two. A look twice tagged counts under its first folder, and its extra tags are cleaned by the rewrite. Folders named ahead in the subtree move with it.",
    right: "show:write",
    profiles: ["design"],
    schema: z.object({ from: folderSource, to: folderName }),
    run: async ({ from, to }, ctx) => {
      if (to.startsWith(from + "/")) throw new Error(say(`« ${to} » serait un sous-dossier de « ${from} »`, `“${to}” would become a sub-folder of “${from}”`));
      if (from === to) return { renamed: 0, from, to };
      const subtree = underFolder(from);
      await refile(subtree.map((look) => ({ look, folder: renamedPath(folderOf(look.tags)!, from, to) })), ctx);
      const stored = show.settings.folders.map((f) => renamedPath(f, from, to));
      if (stored.some((f, i) => f !== show.settings.folders[i])) setNamedFolders(stored);
      return { renamed: subtree.length, from, to };
    },
  });
  reg.register({
    name: "show.folder.delete",
    title: "Dissoudre un dossier",
    titleEn: "Dissolve a folder",
    hints: "DI",
    description: "Empties a folder, its sub-folders included: every look of them goes back « sans dossier » (the looks stay), and folders named ahead in the subtree stop existing.",
    right: "show:write",
    profiles: ["design"],
    schema: z.object({ folder: folderSource }),
    run: async ({ folder }, ctx) => {
      const disbanded = await moveThroughLookPut(underFolder(folder), undefined, ctx);
      const left = show.settings.folders.filter((f) => f !== folder && !f.startsWith(folder + "/"));
      if (left.length !== show.settings.folders.length) setNamedFolders(left);
      return { disbanded };
    },
  });
  reg.register({
    name: "show.folder.nest",
    title: "Nicher un dossier",
    titleEn: "Nest a folder",
    hints: "I",
    description: "Moves a folder — its looks and sub-folders along — under a parent folder (« B » under « A » becomes « A/B »), or back to the top level when `under` is absent.",
    right: "show:write",
    profiles: ["design"],
    schema: z.object({ src: folderSource, under: folderSource.optional() }),
    run: async ({ src, under }, ctx) => {
      const target = nestOf(src, under);
      if (target === undefined) throw new Error(say(`« ${src} » ne peut pas se placer sous « ${under} » : sa propre branche`, `“${src}” cannot be nested under “${under}”: its own branch`));
      if (target === src) return { nested: 0, from: src, to: target };
      const exists = underFolder(src).length > 0 || show.settings.folders.some((f) => f === src || f.startsWith(src + "/"));
      if (!exists) throw new Error(say(`dossier inconnu : ${src}`, `unknown folder: ${src}`));
      // dropped where a folder of that name already sits: refused rather than merged unseen (show.folder.rename merges on purpose)
      if (underFolder(target).length > 0 || show.settings.folders.some((f) => f === target || f.startsWith(target + "/"))) throw new Error(say(`« ${target} » existe déjà : renommer « ${src} » pour les fusionner`, `“${target}” already exists: rename “${src}” onto it to merge them`));
      const out = (await reg.invoke("show.folder.rename", { from: src, to: target }, ctx)) as { renamed: number };
      return { nested: out.renamed, from: src, to: target };
    },
  });
}
