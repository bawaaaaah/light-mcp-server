# Glossaire

| Terme | Définition |
|---|---|
| **Machine** | Configuration propre à l'ordinateur qui fait tourner le serveur : interfaces réseau, IP Art-Net, ports MIDI. Jamais stockée dans un show. |
| **Lieu** | Une salle et son kit : patch, fixtures, scène virtuelle, canevas et leur rendu, règles du lieu. |
| **Show** | Le contenu artistique : looks, techniques, chants, setlists, mappings MIDI/OSC, dashboards, notes. Un show se charge **sur** un lieu. |
| **Fixture** | Un appareil DMX (barre LED, PAR, lyre, machine…). Son **type** vient de la bibliothèque, son **instance** est patchée dans un lieu. |
| **Cellule** | Un segment adressable d'une fixture multi-cellules (par exemple un segment d'une barre LED). |
| **Attribut** | Une grandeur normalisée de 0 à 1 (intensité, couleur, pan, zoom…) manipulée par le moteur avant la conversion en DMX. |
| **Capability** | La signification d'une plage de valeurs d'un canal DMX. Elle porte des tags (`soundActive`, `strobe`, `uv`…). |
| **Scène virtuelle (stage)** | Plan du lieu : zones (avec hauteur), positions, montage, orientation et rôles des fixtures. |
| **Zone protégée** | Une zone que le moteur interdit d'éclairer au-delà de règles fixées (pupitre, public). |
| **Rôle (de fixture)** | La fonction d'éclairage d'une fixture : face, contre, douche, wash public, effet… |
| **Canevas** | Surface abstraite sur laquelle on écrit les effets : ligne, ligne miroir, anneau, grille. |
| **Rendu** | La correspondance canevas → fixtures d'un lieu. C'est ce qui rend un show portable d'une salle à l'autre. |
| **Look** | Un état visuel (couleurs, effets) rappelable. Par défaut il ne contient **pas d'intensité**. |
| **Technique** | Un modèle d'effet paramétrable écrit sur un canevas : damier, palette qui tourne, creux qui tourne, masques, respiration, orage, flamme, flash… |
| **Preset** | Un modèle (technique ou look) avec des emplacements à remplir : palette, cible, cadence. |
| **Palette** | Un jeu nommé de 1 à 16 couleurs, utilisé **par référence**. |
| **Attaque** | Le rapport fondu/durée d'un pas. 0 % « claque » (bord franc), 100 % « respire » (fondu continu). |
| **Profil de cadence** | Un multiple de temps (×½, ×1, ×2, 1 mesure) combiné à une attaque. |
| **Durée musicale** | Une durée exprimée en temps ou en mesures, recalculée en direct selon le BPM. |
| **Chant** | Un morceau : ambiance globale, sections, boutons et/ou timeline, tempo. |
| **Section** | Une partie d'un chant (intro, couplet, refrain…) avec son look, son repère et ses drapeaux. |
| **Grille de chant** | Tableau de conception : section → idée-clé → ambiance → dominante/accent → énergie → transition. |
| **Repère** | Le moment structurel qui déclenche une section (« l'entrée franche du groupe »). |
| **Drapeaux de section** | `manualOnly` (au doigt seulement), `noCut` (rien ne s'éteint), plancher d'intensité. |
| **Groupe** | Objet unifié qui contient des membres et des sous-groupes. Il peut avoir un **master** proportionnel, être **exclusif**, porter des **limites**, et inclure ou exclure des presets d'effets. |
| **Master** | Le niveau d'un groupe. Il multiplie la sortie de ses membres, comme un DCA. |
| **Grand master** | Le master du groupe racine. |
| **Exclusif** | Un groupe où un seul membre est actif à la fois : en lancer un relâche les autres. |
| **Conflit** | Deux looks actifs hors d'un même groupe exclusif qui écrivent les mêmes attributs des mêmes fixtures. Il est signalé. |
| **Mode Déclencher** | Mode MIDI : une note on active toujours et ne coupe jamais. C'est l'exclusivité qui relâche. |
| **Mode Latch** | Mode MIDI : une note on active, la suivante désactive. |
| **Mode Momentané** | Mode MIDI : actif tant que la note est tenue, niveau = vélocité. Le rejeu met le niveau à jour, aftertouch en option. |
| **Registre de notes** | La table des notes MIDI épinglées d'un show. Une note attribuée ne change jamais de sens. |
| **Bande de notes** | Une plage de notes réservée à un usage (bibliothèque commune, chants d'un événement…). |
| **Règle** | Une contrainte (max, plage, capability interdite…) appliquée en dernier par le moteur. |
| **Marqueur** | Une règle posée sur un widget : max sur un fader, « danger », « interdit à l'IA ». |
| **Panic neutre** | Bouton de secours : coupe effets, strobe, UV et machines, puis rappelle le preset de scène choisi à l'avance pour le show (son « look de secours »). Si aucun preset n'est défini, il fait un Blackout. |
| **Blackout** | Bouton de secours : tout à zéro, strobe compris. |
| **Proposition** | Un changement préparé (diff et `proposalId`) que l'utilisateur valide avant de l'appliquer. |
| **Sélecteur** | Une désignation par le sens (rôle, zone, groupe, tag, `near`, `except`) plutôt que par adresse. |
| **Couche de commandes** | Le point d'entrée unique de toutes les actions (UI, MIDI, OSC, MCP, timeline, CLI). |
| **Coquille** | Un fichier `.adg` exporté tel quel par Ableton, qu'on clone pour générer les racks. |
| **`.lightshow`** | Archive compressée d'un show (et/ou d'un lieu), téléchargeable et rechargeable. |
