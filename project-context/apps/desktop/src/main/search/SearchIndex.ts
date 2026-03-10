import Database from "better-sqlite3";
import { basename, extname, resolve, sep, join, dirname } from "path";
import { readdir, readFile, stat } from "fs/promises";
import type { Dirent } from "fs";

type SearchResult = {
  path: string;
  name: string;
  ext: string;
  snippet: string;
  score: number;
};

const MAX_FILE_BYTES = 1_000_000;
const CONVERTED_DIR = ".curator-converted";
const CONVERTED_EXTENSIONS = new Set([
  ".docx",
  ".pdf",
  ".pptx",
  ".xlsx"
]);
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  ".cache",
  "coverage",
  ".curator-converted"
]);

const normalizeRoot = (root: string) => {
  const resolved = resolve(root);
  return resolved.endsWith(sep) ? resolved : `${resolved}${sep}`;
};

const isInsideRoot = (root: string, target: string) => {
  const normalizedRoot = normalizeRoot(root);
  const normalizedTarget = resolve(target);
  return normalizedTarget.startsWith(normalizedRoot);
};

const getSidecarPath = (originalPath: string) => {
  const dir = dirname(originalPath);
  const base = basename(originalPath);
  return join(dir, CONVERTED_DIR, `${base}.md`);
};

const buildFtsQuery = (raw: string) => {
  const tokens = raw
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/[^a-zA-Z0-9_-]/g, ""))
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return "";
  return tokens.map((token) => `${token}*`).join(" ");
};

const walkFiles = async (
  dir: string,
  allowed: Set<string>,
  results: string[] = []
) => {
  let entries: Dirent[];
  try {
    entries = (await readdir(dir, { withFileTypes: true })) as Dirent[];
  } catch {
    return results;
  }
  for (const entry of entries) {
    const entryName = entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entryName)) continue;
      await walkFiles(join(dir, entryName), allowed, results);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = extname(entryName).toLowerCase();
    if (!allowed.has(ext)) continue;
    results.push(join(dir, entryName));
  }
  return results;
};

export class SearchIndex {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        ext TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS files_fts
      USING fts5(path, name, ext, content, tokenize = 'porter');
    `);
  }

  indexWorkspace = (root: string, allowed: Set<string>) => {
    const files = walkFiles(root, allowed);
    return files.then(async (paths) => {
      const existing = this.db
        .prepare("SELECT path FROM files WHERE path LIKE ?")
        .all(`${normalizeRoot(root)}%`) as { path: string }[];
      const existingPaths = existing.map((row) => row.path);
      const existingSet = new Set(existingPaths);
      const nextSet = new Set(paths);

      const remove = this.db.prepare("DELETE FROM files WHERE path = ?");
      const removeFts = this.db.prepare(
        "DELETE FROM files_fts WHERE path = ?"
      );
      const insert = this.db.prepare(
        "INSERT OR REPLACE INTO files(path, name, ext, mtime, size) VALUES (?, ?, ?, ?, ?)"
      );
      const insertFts = this.db.prepare(
        "INSERT INTO files_fts(path, name, ext, content) VALUES (?, ?, ?, ?)"
      );

      const transaction = this.db.transaction(() => {
        for (const path of existingSet) {
          if (!nextSet.has(path)) {
            remove.run(path);
            removeFts.run(path);
          }
        }
      });
      transaction();

      for (const path of paths) {
        await this.indexFileInternal(path, allowed, insert, insertFts);
      }
    });
  };

  indexFile = async (path: string, allowed: Set<string>) => {
    const insert = this.db.prepare(
      "INSERT OR REPLACE INTO files(path, name, ext, mtime, size) VALUES (?, ?, ?, ?, ?)"
    );
    const insertFts = this.db.prepare(
      "INSERT INTO files_fts(path, name, ext, content) VALUES (?, ?, ?, ?)"
    );
    await this.indexFileInternal(path, allowed, insert, insertFts);
  };

  private indexFileInternal = async (
    path: string,
    allowed: Set<string>,
    insert: Database.Statement,
    insertFts: Database.Statement
  ) => {
    const ext = extname(path).toLowerCase();
    if (!allowed.has(ext)) return;
    let info;
    try {
      info = await stat(path);
    } catch {
      return;
    }
    const name = basename(path);
    const mtime = Math.floor(info.mtimeMs);
    const size = info.size;
    insert.run(path, name, ext, mtime, size);

    let content = "";
    if (CONVERTED_EXTENSIONS.has(ext)) {
      try {
        const sidecarPath = getSidecarPath(path);
        const sidecarInfo = await stat(sidecarPath);
        if (sidecarInfo.size <= MAX_FILE_BYTES) {
          content = await readFile(sidecarPath, "utf-8");
        }
      } catch {
        content = "";
      }
    } else if (size <= MAX_FILE_BYTES) {
      try {
        content = await readFile(path, "utf-8");
      } catch {
        content = "";
      }
    }
    this.db.prepare("DELETE FROM files_fts WHERE path = ?").run(path);
    insertFts.run(path, name, ext, content);
  };

  searchFiles = (root: string, query: string, limit = 50): SearchResult[] => {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const ftsQuery = buildFtsQuery(trimmed);
    if (!ftsQuery) return [];
    const rootPrefix = normalizeRoot(root);
    const stmt = this.db.prepare(
      `SELECT path, name, ext,
        snippet(files_fts, 3, '[', ']', '…', 14) as snippet,
        bm25(files_fts) as score
       FROM files_fts
       WHERE files_fts MATCH ? AND path LIKE ?
       ORDER BY score
       LIMIT ?`
    );
    const rows = stmt.all(ftsQuery, `${rootPrefix}%`, limit) as SearchResult[];
    if (rows.length > 0) {
      return rows;
    }

    const fallback = this.db.prepare(
      `SELECT path, name, ext,
        '' as snippet,
        0 as score
       FROM files
       WHERE path LIKE ? AND (name LIKE ? OR path LIKE ?)
       ORDER BY name
       LIMIT ?`
    );
    const like = `%${trimmed}%`;
    return fallback.all(`${rootPrefix}%`, like, like, limit) as SearchResult[];
  };

  searchContext = (root: string, query: string, limit = 12) => {
    const rows = this.searchFiles(root, query, limit);
    return rows
      .filter((row) => isInsideRoot(root, row.path))
      .map((row) => row);
  };
}
