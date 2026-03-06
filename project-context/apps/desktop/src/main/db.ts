import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

export class DatabaseManager {
  private dbs: Map<string, Database.Database> = new Map();

  private getDb(workspacePath: string): Database.Database {
    if (this.dbs.has(workspacePath)) {
      return this.dbs.get(workspacePath)!;
    }

    const curatorDir = path.join(workspacePath, ".curator");
    if (!fs.existsSync(curatorDir)) {
      fs.mkdirSync(curatorDir, { recursive: true });
    }

    const dbPath = path.join(curatorDir, "curator.db");
    const db = new Database(dbPath);
    
    // Initialize schema
    db.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );
      
      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );
      
      CREATE TABLE IF NOT EXISTS kv_store (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    this.dbs.set(workspacePath, db);
    return db;
  }

  saveMessage(workspacePath: string, role: string, text: string) {
    const db = this.getDb(workspacePath);
    const stmt = db.prepare("INSERT INTO chats (role, text, timestamp) VALUES (?, ?, ?)");
    return stmt.run(role, text, Date.now());
  }

  getMessages(workspacePath: string) {
    const db = this.getDb(workspacePath);
    const stmt = db.prepare("SELECT role, text, timestamp FROM chats ORDER BY timestamp ASC");
    return stmt.all();
  }

  saveSnapshot(workspacePath: string, fileId: string, content: string) {
    const db = this.getDb(workspacePath);
    const stmt = db.prepare("INSERT INTO snapshots (file_id, content, timestamp) VALUES (?, ?, ?)");
    return stmt.run(fileId, content, Date.now());
  }

  getSnapshots(workspacePath: string, fileId: string) {
    const db = this.getDb(workspacePath);
    const stmt = db.prepare("SELECT id, content, timestamp FROM snapshots WHERE file_id = ? ORDER BY timestamp DESC LIMIT 50");
    return stmt.all();
  }

  setLastOpened(workspacePath: string, fileId: string) {
    const db = this.getDb(workspacePath);
    const stmt = db.prepare("INSERT OR REPLACE INTO kv_store (key, value) VALUES ('last_opened', ?)");
    return stmt.run(fileId);
  }

  getLastOpened(workspacePath: string) {
    const db = this.getDb(workspacePath);
    const stmt = db.prepare("SELECT value FROM kv_store WHERE key = 'last_opened'");
    const result = stmt.get() as { value: string } | undefined;
    return result ? result.value : null;
  }

  grantPermission(workspacePath: string, action: string) {
    const db = this.getDb(workspacePath);
    const key = `permission:${action}`;
    const stmt = db.prepare("INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)");
    return stmt.run(key, "granted");
  }

  hasPermission(workspacePath: string, action: string): boolean {
    const db = this.getDb(workspacePath);
    const key = `permission:${action}`;
    const stmt = db.prepare("SELECT value FROM kv_store WHERE key = ?");
    const result = stmt.get(key) as { value: string } | undefined;
    return result?.value === "granted";
  }

  revokePermission(workspacePath: string, action: string) {
    const db = this.getDb(workspacePath);
    const key = `permission:${action}`;
    const stmt = db.prepare("DELETE FROM kv_store WHERE key = ?");
    return stmt.run(key);
  }
  
  close(workspacePath: string) {
      if (this.dbs.has(workspacePath)) {
          this.dbs.get(workspacePath)!.close();
          this.dbs.delete(workspacePath);
      }
  }
}
