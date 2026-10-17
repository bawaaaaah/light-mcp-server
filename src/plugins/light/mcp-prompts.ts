/**
 * MCP prompts (docs/specs/mcp.md, « Prompts »): guided workflows a client offers as commands
 * (claude.ai lists them). Text only: each one chains existing tools and holds no logic of its own.
 * In French, the language the show is designed in. A test checks every tool they cite exists.
 */
import { z } from "zod";

export interface LightPrompt {
  name: string;
  title: string;
  description: string;
  /** Prompt arguments are strings (MCP); all optional so a client can start one bare. */
  args: Record<string, string>;
  text(args: Record<string, string | undefined>): string;
}

const opt = (v: string | undefined, before = " ", after = "") => (v?.trim() ? `${before}${v.trim()}${after}` : "");

export const PROMPTS: LightPrompt[] = [
  {
    name: "preshow_check",
    title: "Vérifier avant le service",
    description: "Contrôle que la régie est prête (sortie, show, patch, secours, changements récents), sans rien jouer.",
    args: {},
    text: () =>
      [
        "Vérifie que la régie lumière est prête pour le service, sans rien changer à la lumière.",
        "1. light_output_status : la sortie est-elle en veille (rien n'atteint les projecteurs) ? D'autres consoles Art-Net sont-elles vues ?",
        "2. light_show_lint : les erreurs (✖) et les alertes (⚠), avec ce qu'il faut faire pour chacune.",
        "3. light_venue_patch_check : chevauchements d'adresses, projecteurs sans définition.",
        "4. light_show_settings et light_snapshot_list : le Panic a-t-il un instantané ou un look de secours ?",
        "5. light_activity_list : des changements récents inattendus (qui, d'où) ?",
        "6. light_selftest_run fait jouer les looks : ne le lance que si la sortie est en veille, ou si l'utilisateur te le demande.",
        "Rends un rapport court, « prêt » ou « à corriger », point par point, sans lancer de look.",
      ].join("\n"),
  },
  {
    name: "import_qlc_project",
    title: "Importer un workspace QLC+",
    description: "Importe un workspace QLC+ (.qxw) : proposition, définitions manquantes, application, reconstruction, vérification.",
    args: { file: "Nom du fichier .qxw (son contenu est demandé à l'utilisateur)" },
    text: ({ file }) =>
      [
        `Importe le workspace QLC+${opt(file, " « ", " »")} dans le show.`,
        "1. Demande le contenu du fichier .qxw si tu ne l'as pas, puis light_import_qxw sans apply : c'est une proposition, rien n'est écrit. Lis le rapport : définitions manquantes (report.missingDefinitions), avertissements, ce qui est converti.",
        "2. Pour chaque définition manquante, demande son fichier .qxf (bibliothèque fournie avec QLC+ ou dossier de l'utilisateur) et ajoute-le avec light_fixture_definition_add, puis refais la proposition.",
        "3. Montre le résumé ; sur l'accord de l'utilisateur, light_import_qxw avec apply. Un autre workspace que celui du show est refusé : propose alors un show neuf (light_show_create avec venue « new » et le workspace).",
        "4. Propose light_look_rebuild : les looks importés deviennent des techniques éditables quand le rendu reste fidèle.",
        "5. Pour finir, light_show_lint et light_venue_patch_check ; light_selftest_run seulement si la sortie est en veille (light_output_status).",
      ].join("\n"),
  },
  {
    name: "setup_venue",
    title: "Préparer le lieu",
    description: "Patch, scène et zones, canevas, garde-fous d'un lieu.",
    args: { description: "La salle et le kit en quelques mots" },
    text: ({ description }) =>
      [
        `Prépare le lieu${opt(description, " : ")}.`,
        "1. light_venue_library : les modèles disponibles ; light_venue_fixture_list : ce qui est déjà patché.",
        "2. Patch : light_venue_fixture_put pour chaque projecteur (modèle, mode, univers, adresse, rôle) ; light_venue_patch_check après chaque série.",
        "3. Scène : zones avec light_stage_zone_put (scène, public, pupitre…, protégées au besoin) ; une ligne de projecteurs se place d'un coup le long d'un bord de zone avec light_venue_fixture_arrange ; où pointe chaque projecteur avec light_venue_fixture_orient (public, mur de scène, jardin, cour, plafond, sol) ; light_stage_describe pour relire.",
        "4. Canevas : light_venue_canvas_auto avec les projecteurs qui jouent ensemble, dans l'ordre de la scène.",
        "5. Garde-fous du lieu : light_rule_put (UV max, modes son-actif interdits…).",
        "Demande confirmation avant d'écrire si l'utilisateur n'a pas donné le patch complet.",
      ].join("\n"),
  },
  {
    name: "define_canvas",
    title: "Définir un canevas",
    description: "Met les cellules de projecteurs bout à bout pour que les looks s'y dessinent.",
    args: { fixtures: "Les projecteurs, dans l'ordre (facultatif)", topology: "line, line-mirror ou ring (facultatif)" },
    text: ({ fixtures, topology }) =>
      [
        `Crée un canevas${opt(fixtures, " avec ")}${opt(topology, ", en ")} : les cellules des projecteurs mises bout à bout, sur lesquelles les looks se dessinent.`,
        "1. light_venue_fixture_list et light_venue_fixture_channels : quels projecteurs, combien de têtes chacun.",
        "2. light_venue_canvas_auto avec ces projecteurs et une topologie (line, line-mirror, ring) ; l'ordre compte (de cour à jardin, par exemple).",
        "3. light_look_preview d'un look simple sur ce canevas, pour vérifier l'ordre des cellules avant de s'en servir.",
      ].join("\n"),
  },
  {
    name: "program_song",
    title: "Programmer un chant",
    description: "Grille d'un chant : sections, ambiance, un look par section, programme de règles.",
    args: { title: "Titre du chant", bpm: "Tempo (facultatif)", structure: "Couplet, refrain, pont… (facultatif)", mood: "Ambiance (facultatif)" },
    text: ({ title, bpm, structure, mood }) =>
      [
        `Programme le chant${opt(title, " « ", " »")}${opt(bpm, ", ", " BPM")}${opt(structure, ", structure : ")}${opt(mood, ", ambiance : ")}.`,
        "1. light_song_list : existe-t-il déjà ? light_look_list : les looks disponibles (résumés).",
        "2. light_song_grid_fill : une grille (sections, ambiance, énergie) à partir de la structure et de l'ambiance.",
        "3. Pour chaque section, un look existant ou un nouveau par intention (light_look_from_intent sans l'enregistrer d'abord : montre son explication) ; moments calmes : attaque qui respire ; refrains : plus d'énergie.",
        "4. light_song_put avec les sections, leur look et leur repère ; un programme de règles (light_program_list) là où il le faut (prière : rien au-dessus de 40 %).",
        "5. light_show_lint pour finir.",
      ].join("\n"),
  },
  {
    name: "build_setlist",
    title: "Construire une setlist",
    description: "Ordonne les chants d'un service et vérifie les enchaînements.",
    args: { name: "Nom de la setlist", songs: "Les chants, dans l'ordre (facultatif)" },
    text: ({ name, songs }) =>
      [
        `Construis la setlist${opt(name, " « ", " »")}${opt(songs, " : ")}.`,
        "1. light_song_list : les chants connus ; signale ceux qui manquent (ils se programment avec le prompt program_song).",
        "2. light_setlist_put avec les chants dans l'ordre.",
        "3. Vérifie les enchaînements : deux chants voisins de même ambiance, sections sans look (light_show_lint).",
      ].join("\n"),
  },
  {
    name: "rehearsal_review",
    title: "Bilan de répétition",
    description: "Ce qui a été joué et retouché pendant la répétition, et les corrections à proposer, sans rien changer.",
    args: {},
    text: () =>
      [
        "Fais le bilan de la répétition, sans rien changer.",
        "1. light_activity_list (limit 200) : ce qui a été joué et réglé, par qui, d'où ; une rafale sur un fader (count élevé) montre un réglage hésitant.",
        "2. light_notes_search : les notes prises.",
        "3. light_show_lint : ce qui reste à corriger.",
        "Rends : ce qui a bien marché, les looks ou réglages souvent retouchés, et les corrections proposées (une par ligne, avec l'outil qui la ferait), à valider par l'utilisateur.",
        "Une modification regrettée se reprend avec light_history_undo (le undo, at et until de sa ligne d'activité), après avoir dit ce qui a été changé depuis sur le même objet.",
      ].join("\n"),
  },
];

/** The zod shape the MCP SDK wants for a prompt's arguments. */
export const promptArgs = (p: LightPrompt) => Object.fromEntries(Object.entries(p.args).map(([k, d]) => [k, z.string().optional().describe(d)]));
