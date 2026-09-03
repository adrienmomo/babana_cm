// L0-10 -- cohérence de la chaîne de configuration (D59, amoa/01-architecture.md §9 sexies).
//
// Une variable de configuration a trois moments : DÉCLARÉE (infra/env/.env.example), LIVRÉE
// (infra/compose.yaml pour un conteneur, l'environnement exporté du processus de build pour une
// variable lue à la compilation, un post_init_hook pour ce qu'Odoo doit traduire en
// enregistrement), CONSOMMÉE (le code qui la lit). Ce module recense les trois pour chaque
// variable rencontrée et signale tout maillon manquant, dans les deux sens -- voir
// docs/operations/configuration.md pour la table complète et test/config/config-coherence.test.ts
// pour la preuve que chaque défaut ci-dessous est réellement détecté.
//
// Portée délibérée (à lire avant d'étendre ce fichier) : la détection "code -> nom de variable"
// ne porte que sur `process.env.X` (JS/TS) et `os.environ.get/[]/getenv` + la convention locale
// `X_ENV = "X"` (Python, services/push.py) -- jamais sur un `$NOM` en script shell, qui ressemble
// à une variable d'environnement sans en être une (variable locale du script) et produirait des
// faux positifs. Les scripts shell (bootstrap/backup/restore/smoke-test) sont donc vérifiés dans
// l'autre sens : on cherche si un nom DÉJÀ connu y apparaît, jamais on n'y invente un nom.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import {
  EXCEPTIONS,
  INTERNAL_TOPOLOGY_NAMES,
  SELF_SUFFICIENT_DEFAULTS,
  THIRD_PARTY_IMAGE_CONSUMED,
} from './variables';

export interface Occurrence {
  file: string;
  line: number;
}

export interface VariableStatus {
  name: string;
  declared: boolean;
  delivered: boolean;
  consumed: boolean;
  exception?: string;
  delivered_evidence: Occurrence[];
  consumed_evidence: Occurrence[];
}

export interface CoherenceReport {
  problems: string[];
  statuses: VariableStatus[];
}

const VAR_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'dist-web', 'android', 'ios', '__pycache__', 'coverage', 'build',
  // Les suites de test lisent souvent des variables de PARAMÉTRAGE DE TEST (nombre d'itérations
  // d'un banc de concurrence, adresse d'un mock choisie par le test) qui n'ont rien à voir avec
  // la chaîne de configuration de production -- p. ex. GOOGLE_MOCK_IDENTITY_URL ou
  // L3_13_ITERATIONS. Ce ne sont pas des variables déclarées, livrées ou consommées au sens de
  // L0-10 ; les compter ferait échouer ce test à chaque nouveau paramètre de banc d'essai.
  'test', 'tests', '__tests__',
]);
const JS_EXTS = ['.ts', '.tsx', '.js'];
const PY_EXTS = ['.py'];

function lineOf(contents: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < contents.length; i++) {
    if (contents.charCodeAt(i) === 10) line++;
  }
  return line;
}

function walk(dir: string, exts: string[], out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, exts, out);
    } else if (exts.includes(extname(entry))) {
      out.push(full);
    }
  }
  return out;
}

function collect(
  contents: string,
  re: RegExp,
  file: string,
  out: Map<string, Occurrence[]>,
  groupIndex = 1
): void {
  const local = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m: RegExpExecArray | null;
  while ((m = local.exec(contents))) {
    const name = m[groupIndex];
    if (!name) continue;
    const list = out.get(name) ?? [];
    list.push({ file, line: lineOf(contents, m.index) });
    out.set(name, list);
  }
}

function merge(...maps: Map<string, Occurrence[]>[]): Map<string, Occurrence[]> {
  const out = new Map<string, Occurrence[]>();
  for (const map of maps) {
    for (const [name, occ] of map) {
      out.set(name, [...(out.get(name) ?? []), ...occ]);
    }
  }
  return out;
}

/** Remonte depuis `startDir` jusqu'au répertoire "code/" (celui qui porte infra/env/.env.example)
 * -- tolère un lancement depuis n'importe quel sous-répertoire du dépôt. */
export function findRepoRoot(startDir: string): string {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, 'infra', 'env', '.env.example'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) {
      throw new Error(`infra/env/.env.example introuvable en remontant depuis ${startDir}`);
    }
    dir = parent;
  }
}

export function parseDeclaredVariables(repoRoot: string): Set<string> {
  const path = join(repoRoot, 'infra', 'env', '.env.example');
  const contents = readFileSync(path, 'utf8');
  const declared = new Set<string>();
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const name = line.slice(0, eq).trim();
    if (VAR_NAME_RE.test(name)) declared.add(name);
  }
  return declared;
}

// --- Consommation ------------------------------------------------------------------------------

// `[A-Z][A-Z0-9_]+` (au moins deux caractères) plutôt que `[A-Z][A-Z0-9_]*` : un commentaire qui
// écrit littéralement `process.env.X` comme exemple générique (apps/*/config.ts, en-tête de
// fichier) ne doit pas être lu comme une variable réelle nommée "X" -- aucune variable de ce
// dépôt n'a un nom d'un seul caractère.
const JS_PROCESS_ENV_RE = /process\.env\.([A-Z][A-Z0-9_]+)/g;
const PY_ENVIRON_GET_RE = /os\.environ\.get\(\s*["']([A-Z][A-Z0-9_]+)["']/g;
const PY_ENVIRON_BRACKET_RE = /os\.environ\[\s*["']([A-Z][A-Z0-9_]+)["']\s*\]/g;
const PY_GETENV_RE = /os\.getenv\(\s*["']([A-Z][A-Z0-9_]+)["']/g;
const PY_ENV_CONST_RE = /\b[A-Z][A-Z0-9_]*_ENV\s*=\s*["']([A-Z][A-Z0-9_]+)["']/g;
const CADDY_VAR_RE = /\{\$([A-Z][A-Z0-9_]+)(?::[^}]*)?\}/g;

const CONSUMPTION_DIRS = ['apps', 'packages', 'services'];
/** Scripts shell qui consomment réellement une variable déclarée (jamais une source pour
 * DÉCOUVRIR un nom -- voir la note de portée en tête de fichier). */
const SHELL_CONSUMPTION_FILES = [
  'infra/minio/bootstrap.sh',
  'infra/production/backup.sh',
  'infra/production/restore.sh',
  'infra/smoke-test.sh',
];

/** Scan "vers l'avant" : trouve tout nom de variable réellement lu par le code JS/TS/Python et
 * par le Caddyfile. C'est ce scan qui rend le critère 2 possible (une variable ajoutée au code
 * sans être déclarée doit apparaître ici sans être dans `declared`). */
export function scanConsumedForward(repoRoot: string): Map<string, Occurrence[]> {
  const out = new Map<string, Occurrence[]>();
  for (const dir of CONSUMPTION_DIRS) {
    for (const file of walk(join(repoRoot, dir), [...JS_EXTS, ...PY_EXTS])) {
      const rel = relative(repoRoot, file);
      const contents = readFileSync(file, 'utf8');
      if (JS_EXTS.includes(extname(file))) {
        collect(contents, JS_PROCESS_ENV_RE, rel, out);
      } else {
        collect(contents, PY_ENVIRON_GET_RE, rel, out);
        collect(contents, PY_ENVIRON_BRACKET_RE, rel, out);
        collect(contents, PY_GETENV_RE, rel, out);
        collect(contents, PY_ENV_CONST_RE, rel, out);
      }
    }
  }
  const caddyfile = join(repoRoot, 'infra/caddy/Caddyfile');
  if (existsSync(caddyfile)) {
    collect(readFileSync(caddyfile, 'utf8'), CADDY_VAR_RE, 'infra/caddy/Caddyfile', out);
  }
  return out;
}

/** Scan "vers l'arrière" : pour chaque nom déjà DÉCLARÉ, vérifie sa présence littérale dans les
 * scripts shell de consommation. Ne sert jamais à découvrir un nouveau nom (voir note de portée
 * en tête de fichier) -- seulement à compléter la preuve de consommation pour des noms connus. */
export function scanConsumedByKnownShellScripts(
  repoRoot: string,
  candidateNames: Iterable<string>
): Map<string, Occurrence[]> {
  const out = new Map<string, Occurrence[]>();
  for (const relPath of SHELL_CONSUMPTION_FILES) {
    const full = join(repoRoot, relPath);
    if (!existsSync(full)) continue;
    const contents = readFileSync(full, 'utf8');
    for (const name of candidateNames) {
      const re = new RegExp(`\\$\\{?${name}\\b`);
      const m = re.exec(contents);
      if (m) {
        out.set(name, [...(out.get(name) ?? []), { file: relPath, line: lineOf(contents, m.index) }]);
      }
    }
  }
  return out;
}

// --- Livraison -----------------------------------------------------------------------------

const COMPOSE_VAR_RE = /\$\{([A-Z][A-Z0-9_]+)(?::[-?][^}]*)?\}/g;
const MAKEFILE_PASS_THROUGH_RE = /\b([A-Z][A-Z0-9_]+)="\$\(\1\)"/g;
const SHELL_EXPORT_RE = /^[ \t]*export[ \t]+((?:[A-Z][A-Z0-9_]+[ \t]*)+)$/gm;

export function scanDeliveredByCompose(repoRoot: string): Map<string, Occurrence[]> {
  const out = new Map<string, Occurrence[]>();
  for (const relPath of ['infra/compose.yaml', 'infra/compose.dev.yaml']) {
    const full = join(repoRoot, relPath);
    if (existsSync(full)) collect(readFileSync(full, 'utf8'), COMPOSE_VAR_RE, relPath, out);
  }
  return out;
}

export function scanDeliveredByMakefile(repoRoot: string): Map<string, Occurrence[]> {
  const out = new Map<string, Occurrence[]>();
  const full = join(repoRoot, 'Makefile');
  if (existsSync(full)) collect(readFileSync(full, 'utf8'), MAKEFILE_PASS_THROUGH_RE, 'Makefile', out);
  return out;
}

/** `export NOM1 NOM2 ...` explicite dans un script shell (infra/production/deploy.sh et sa
 * bibliothèque) -- le mécanisme même que le défaut du 13 septembre a introduit : `. .env` seul
 * pose des variables de SHELL, jamais transmises à un processus fils sans `export`. */
export function scanDeliveredByShellExport(repoRoot: string, relPaths: string[]): Map<string, Occurrence[]> {
  const out = new Map<string, Occurrence[]>();
  for (const relPath of relPaths) {
    const full = join(repoRoot, relPath);
    if (!existsSync(full)) continue;
    const contents = readFileSync(full, 'utf8');
    let m: RegExpExecArray | null;
    const re = new RegExp(SHELL_EXPORT_RE.source, SHELL_EXPORT_RE.flags);
    while ((m = re.exec(contents))) {
      const line = lineOf(contents, m.index);
      for (const name of (m[1] ?? '').trim().split(/\s+/)) {
        out.set(name, [...(out.get(name) ?? []), { file: relPath, line }]);
      }
    }
  }
  return out;
}

/** Le `post_init_hook` d'Odoo traduit une variable d'environnement en enregistrement (mot de
 * passe administrateur, relais SMTP) -- c'est sa propre forme de "livraison" au sens de cette
 * tâche (amoa/specs/L0-socle.md, L0-10 : "un `_post_init_hook` pour ce qu'Odoo doit traduire en
 * enregistrement"). */
export function scanDeliveredByPostInitHook(repoRoot: string): Map<string, Occurrence[]> {
  const out = new Map<string, Occurrence[]>();
  const full = join(repoRoot, 'services/odoo/addons/babana/__init__.py');
  if (!existsSync(full)) return out;
  const contents = readFileSync(full, 'utf8');
  collect(contents, PY_ENVIRON_GET_RE, 'services/odoo/addons/babana/__init__.py', out);
  collect(contents, PY_ENVIRON_BRACKET_RE, 'services/odoo/addons/babana/__init__.py', out);
  return out;
}

const DEFAULT_SHELL_EXPORT_FILES = [
  'infra/production/deploy.sh',
  'infra/production/lib/build-web-bundle.sh',
];

/** Recense les trois moments de chaque variable rencontrée (déclarée, ou simplement consommée --
 * ce second cas EST le défaut que le critère 2 vérifie) et retourne la liste des maillons
 * manquants, en excluant ce qui a une raison explicite de ne pas suivre le protocole
 * (INTERNAL_TOPOLOGY_NAMES, SELF_SUFFICIENT_DEFAULTS, THIRD_PARTY_IMAGE_CONSUMED, EXCEPTIONS).
 *
 * Ne valide PAS le manifeste EXCEPTIONS lui-même (voir `checkExceptionsManifest` ci-dessous) --
 * cette séparation permet d'exercer cette fonction sur un mini-dépôt synthétique (les tests des
 * critères 2 et 3) sans que les exceptions du VRAI dépôt, qui n'y existent pas, ne polluent le
 * résultat. */
export function checkVariableCoherence(repoRoot: string): CoherenceReport {
  const declared = parseDeclaredVariables(repoRoot);
  const consumedForward = scanConsumedForward(repoRoot);
  const consumedShell = scanConsumedByKnownShellScripts(repoRoot, declared);
  const consumed = merge(consumedForward, consumedShell);

  const delivered = merge(
    scanDeliveredByCompose(repoRoot),
    scanDeliveredByMakefile(repoRoot),
    scanDeliveredByShellExport(repoRoot, DEFAULT_SHELL_EXPORT_FILES),
    scanDeliveredByPostInitHook(repoRoot)
  );

  const exceptionsByName = new Map(EXCEPTIONS.map((e) => [e.name, e]));
  const problems: string[] = [];
  const statuses: VariableStatus[] = [];

  const allNames = new Set<string>([...declared, ...consumedForward.keys()]);

  for (const name of allNames) {
    if (INTERNAL_TOPOLOGY_NAMES.has(name) || SELF_SUFFICIENT_DEFAULTS.has(name)) continue;

    const isDeclared = declared.has(name);
    const consumedEvidence = consumed.get(name) ?? [];
    const deliveredEvidence = delivered.get(name) ?? [];
    const isConsumed = consumedEvidence.length > 0 || THIRD_PARTY_IMAGE_CONSUMED.has(name);
    const isDelivered = deliveredEvidence.length > 0;
    const exception = exceptionsByName.get(name);

    statuses.push({
      name,
      declared: isDeclared,
      delivered: isDelivered,
      consumed: isConsumed,
      exception: exception?.closingTask,
      delivered_evidence: deliveredEvidence,
      consumed_evidence: consumedEvidence,
    });

    if (exception) continue;

    if (!isDeclared) {
      const at = consumedForward.get(name)?.[0];
      problems.push(
        `${name} : consommée${at ? ` (${at.file}:${at.line})` : ''} mais absente de infra/env/.env.example.`
      );
      continue;
    }
    if (!isDelivered) {
      problems.push(
        `${name} : déclarée dans infra/env/.env.example mais rien ne la livre (aucun conteneur ` +
          'infra/compose*.yaml, aucun export de build, aucun post_init_hook).'
      );
      continue;
    }
    if (!isConsumed) {
      problems.push(
        `${name} : déclarée et livrée mais aucune consommation détectée (variable morte, ou hors ` +
          'de la portée de ce scan -- voir docs/operations/configuration.md).'
      );
    }
  }

  return { problems, statuses };
}

/** Valide le manifeste EXCEPTIONS lui-même contre `repoRoot` (critère 4 de L0-10) : chaque
 * exception doit nommer une tâche de fermeture non vide, et correspondre à une variable
 * réellement déclarée dans CE dépôt -- sans quoi elle est obsolète et devrait être retirée. */
export function checkExceptionsManifest(repoRoot: string): string[] {
  const declared = parseDeclaredVariables(repoRoot);
  const problems: string[] = [];
  for (const exception of EXCEPTIONS) {
    if (!exception.closingTask || !exception.closingTask.trim()) {
      problems.push(`Exception ${exception.name} sans tâche de fermeture -- interdit (critère 4 de L0-10).`);
    }
    if (!declared.has(exception.name)) {
      problems.push(
        `Exception ${exception.name} : ne correspond à aucune variable déclarée dans ` +
          'infra/env/.env.example -- exception obsolète, à retirer.'
      );
    }
  }
  return problems;
}

/** Vérification complète, telle qu'exécutée par `make test` contre le vrai dépôt : les trois
 * moments de chaque variable, PLUS la validité du manifeste d'exceptions. */
export function checkCoherence(repoRoot: string): CoherenceReport {
  const { problems, statuses } = checkVariableCoherence(repoRoot);
  return { problems: [...problems, ...checkExceptionsManifest(repoRoot)], statuses };
}
