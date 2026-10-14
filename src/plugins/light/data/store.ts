/**
 * Folder-of-text-files store for venues and shows (docs/specs/data-cli-sdk.md):
 *   <root>/<manifest>.json          { schemaVersion, kind, ... }
 *   <root>/<collection>/<id>.json   one object per file
 *
 * - Stable serialization: keys sorted, 2-space indent, trailing newline → git diffs show exactly
 *   what changed; saving twice produces no diff (idempotent).
 * - Atomic writes (temp file + rename); a timestamped backup of the previous version is kept.
 * - Every object is validated with its collection's zod schema on load and on save.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { ZodType, ZodTypeDef } from "zod";

export const SCHEMA_VERSION = 1;

/** JSON with object keys sorted recursively (arrays keep their order). */
export function stableStringify(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object" && !(v instanceof Uint8Array)) {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
          .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(sort(value), null, 2) + "\n";
}

export const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Turns a label into an id: "Refrain · Wave bleu" → "refrain-wave-bleu". */
export function slugify(label: string): string {
  return (
    label
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "x"
  );
}

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp-${randomBytes(6).toString("hex")}`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

export interface ChangeEvent {
  collection: string;
  id: string;
  kind: "put" | "delete";
}

/** Delay before a live value (fader level) reaches the disk: one write after the last move. */
export const LIVE_WRITE_DELAY_MS = 1000;

export class Collection<T extends { id: string }> {
  private readonly items = new Map<string, T>();
  private readonly pendingLive = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly store: FolderStore,
    readonly name: string,
    private readonly schema: ZodType<T, ZodTypeDef, unknown>,
  ) {
    this.reload();
  }

  /** Re-reads every object from disk (after an archive was restored). */
  reload(): void {
    // the disk wins (archive restored, file edited): pending live values are dropped
    for (const timer of this.pendingLive.values()) clearTimeout(timer);
    this.pendingLive.clear();
    this.items.clear();
    const { store, name, schema } = this;
    const dir = join(store.root, name);
    if (!existsSync(dir)) return;
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
      const parsed = schema.safeParse(JSON.parse(readFileSync(join(dir, file), "utf8")));
      if (!parsed.success) {
        store.loadErrors.push(`${name}/${file} : ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
        continue;
      }
      this.items.set(parsed.data.id, parsed.data);
    }
  }

  get(id: string): T | undefined {
    return this.items.get(id);
  }

  /** Normalises a value with the collection's schema (defaults applied), without storing it. */
  parse(value: unknown): T {
    return this.schema.parse(value);
  }

  list(): T[] {
    return [...this.items.values()];
  }

  has(id: string): boolean {
    return this.items.has(id);
  }

  put(value: unknown): T {
    const item = this.schema.parse(value);
    if (!ID_RE.test(item.id)) throw new Error(`identifiant invalide : « ${item.id} » (a-z, 0-9, - et _)`);
    const dir = join(this.store.root, this.name);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${item.id}.json`);
    const text = stableStringify(item);
    if (existsSync(path)) {
      const previous = readFileSync(path, "utf8");
      if (previous === text) {
        this.items.set(item.id, item);
        return item; // idempotent: no write, no diff
      }
      this.store.backup(`${this.name}/${item.id}.json`, path);
    }
    writeAtomic(path, text);
    this.items.set(item.id, item);
    this.store.emit({ collection: this.name, id: item.id, kind: "put" });
    return item;
  }

  /**
   * Live value (a DCA or fader level moved by hand or MIDI, many times a second): in effect at
   * once, written once after the moves stop, without a backup — it is state, not show design.
   */
  putLive(value: unknown): T {
    const item = this.schema.parse(value);
    if (!this.items.has(item.id)) return this.put(item);
    this.items.set(item.id, item);
    this.store.emit({ collection: this.name, id: item.id, kind: "put" });
    clearTimeout(this.pendingLive.get(item.id));
    const timer = setTimeout(() => this.flushLive(item.id), LIVE_WRITE_DELAY_MS);
    timer.unref?.();
    this.pendingLive.set(item.id, timer);
    return item;
  }

  /** Writes the pending live values now (shutdown, archive, tests). */
  flushLive(id?: string): void {
    for (const key of id ? [id] : [...this.pendingLive.keys()]) {
      clearTimeout(this.pendingLive.get(key));
      this.pendingLive.delete(key);
      const item = this.items.get(key);
      if (!item) continue;
      const dir = join(this.store.root, this.name);
      mkdirSync(dir, { recursive: true });
      writeAtomic(join(dir, `${key}.json`), stableStringify(item));
    }
  }

  delete(id: string): boolean {
    if (!this.items.delete(id)) return false;
    const path = join(this.store.root, this.name, `${id}.json`);
    if (existsSync(path)) {
      this.store.backup(`${this.name}/${id}.json`, path);
      rmSync(path);
    }
    this.store.emit({ collection: this.name, id, kind: "delete" });
    return true;
  }
}

export class FolderStore {
  readonly loadErrors: string[] = [];
  private readonly listeners = new Set<(e: ChangeEvent) => void>();
  private readonly collections = new Map<string, Collection<{ id: string }>>();

  constructor(
    readonly root: string,
    private readonly backupRoot?: string,
  ) {
    mkdirSync(root, { recursive: true });
  }

  collection<T extends { id: string }>(name: string, schema: ZodType<T, ZodTypeDef, unknown>): Collection<T> {
    const existing = this.collections.get(name);
    if (existing) return existing as unknown as Collection<T>;
    const c = new Collection<T>(this, name, schema);
    this.collections.set(name, c as unknown as Collection<{ id: string }>);
    return c;
  }

  /** Writes every pending live value (before an archive, at shutdown). */
  flushLive(): void {
    for (const c of this.collections.values()) c.flushLive();
  }

  /** Re-reads every collection from disk and notifies listeners. */
  reloadAll(): void {
    for (const c of this.collections.values()) c.reload();
    this.emit({ collection: "*", id: "*", kind: "put" });
  }

  readManifest<T>(file: string, schema: ZodType<T, ZodTypeDef, unknown>, fallback: T): T {
    const path = join(this.root, file);
    if (!existsSync(path)) return fallback;
    return schema.parse(JSON.parse(readFileSync(path, "utf8")));
  }

  writeManifest(file: string, value: unknown): void {
    const path = join(this.root, file);
    const text = stableStringify(value);
    if (existsSync(path) && readFileSync(path, "utf8") === text) return;
    writeAtomic(path, text);
  }

  onChange(fn: (e: ChangeEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(e: ChangeEvent): void {
    for (const l of this.listeners) l(e);
  }

  backup(relative: string, path: string): void {
    if (!this.backupRoot) return;
    const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
    const target = join(this.backupRoot, stamp, relative);
    mkdirSync(join(target, ".."), { recursive: true });
    copyFileSync(path, target);
  }
}
