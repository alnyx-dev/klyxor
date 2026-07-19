import path from "path";
import fs from "fs";
import Database from "better-sqlite3";

export interface StoredMessage {
  id?: number;
  session_id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string | null;
  created_at?: number;
}

export interface StoredToolCall {
  id?: number;
  session_id: string;
  tool_name: string;
  arguments_json: string;
  result_preview?: string | null;
  created_at?: number;
}

export interface StoredArtifact {
  id?: number;
  session_id: string;
  kind: string; // e.g., "diff", "file", "log"
  path_or_ref: string;
  payload_json: string; // arbitrary metadata
  created_at?: number;
}

export interface SessionRecord {
  id: string; // externally supplied (e.g., uuid)
  task: string;
  mode: string;
  started_at: number;
  ended_at?: number | null;
}

export class SessionStore {
  private db: Database.Database;

  constructor(private baseDir: string) {
    const dir = path.join(baseDir, ".klyxor");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const dbPath = path.join(dir, "klyxor.db");
    this.db = new Database(dbPath);
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        task TEXT NOT NULL,
        mode TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT,
        tool_call_id TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id)
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);

      CREATE TABLE IF NOT EXISTS tool_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        arguments_json TEXT NOT NULL,
        result_preview TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id)
      );
      CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id, id);

      CREATE TABLE IF NOT EXISTS artifacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        path_or_ref TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id)
      );
      CREATE INDEX IF NOT EXISTS idx_artifacts_session ON artifacts(session_id, id);
    `);
  }

  beginSession(s: SessionRecord) {
    const stmt = this.db.prepare(
      `INSERT INTO sessions (id, task, mode, started_at, ended_at) VALUES (?, ?, ?, ?, NULL)`
    );
    stmt.run(s.id, s.task, s.mode, s.started_at);
  }

  endSession(id: string, endedAt: number = Date.now()) {
    const stmt = this.db.prepare(`UPDATE sessions SET ended_at=? WHERE id=?`);
    stmt.run(endedAt, id);
  }

  addMessage(m: StoredMessage) {
    const stmt = this.db.prepare(
      `INSERT INTO messages (session_id, role, content, tool_call_id, created_at)
       VALUES (?, ?, ?, ?, ?)`
    );
    stmt.run(m.session_id, m.role, m.content ?? null, m.tool_call_id ?? null, m.created_at ?? Date.now());
  }

  addToolCall(t: StoredToolCall) {
    const stmt = this.db.prepare(
      `INSERT INTO tool_calls (session_id, tool_name, arguments_json, result_preview, created_at)
       VALUES (?, ?, ?, ?, ?)`
    );
    stmt.run(t.session_id, t.tool_name, t.arguments_json, t.result_preview ?? null, t.created_at ?? Date.now());
  }

  addArtifact(a: StoredArtifact) {
    const stmt = this.db.prepare(
      `INSERT INTO artifacts (session_id, kind, path_or_ref, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?)`
    );
    stmt.run(a.session_id, a.kind, a.path_or_ref, a.payload_json, a.created_at ?? Date.now());
  }

  exportSession(sessionId: string): {
    session: SessionRecord;
    messages: StoredMessage[];
    tool_calls: StoredToolCall[];
    artifacts: StoredArtifact[];
  } | null {
    const s = this.db.prepare(`SELECT id, task, mode, started_at, ended_at FROM sessions WHERE id=?`).get(sessionId) as SessionRecord | undefined;
    if (!s) return null;
    const messages = this.db.prepare(`SELECT * FROM messages WHERE session_id=? ORDER BY id`).all(sessionId) as StoredMessage[];
    const tool_calls = this.db.prepare(`SELECT * FROM tool_calls WHERE session_id=? ORDER BY id`).all(sessionId) as StoredToolCall[];
    const artifacts = this.db.prepare(`SELECT * FROM artifacts WHERE session_id=? ORDER BY id`).all(sessionId) as StoredArtifact[];
    return { session: s, messages, tool_calls, artifacts };
  }
}
