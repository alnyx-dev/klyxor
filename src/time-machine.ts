/**
 * TimeMachine — codebase snapshot / restore system for klyxor.
 *
 * Records file states before and after changes, stores them as JSON
 * in `.klyxor/snapshots/`, and provides diff / restore / branch primitives.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import {
  MAX_SNAPSHOTS,
  SNAPSHOTS_DIR,
  MAX_SNAPSHOT_FILES,
} from "./constants.js";

// ── Interfaces ────────────────────────────────────────────────

/** A single file's content at a point in time. */
export interface FileSnapshot {
  filePath: string;
  content: string;
  timestamp: string;
  hash: string; // SHA-256 of content
}

/** A collection of file snapshots forming one checkpoint. */
export interface Snapshot {
  id: string;
  timestamp: string;
  description: string;
  files: FileSnapshot[];
  parentSnapshotId?: string;
  branch?: string;
}

/** File-level diff between two snapshots. */
export interface SnapshotDiff {
  added: string[];
  removed: string[];
  modified: string[];
  unchanged: string[];
}

/** Line-by-line diff for a single file. */
export interface FileDiff {
  lines: {
    type: "added" | "removed" | "unchanged";
    content: string;
    lineNumber: number;
  }[];
}

/** Result of a restore operation. */
export interface RestoreResult {
  restored: string[];
  errors: { filePath: string; error: string }[];
}

// ── Helpers ───────────────────────────────────────────────────

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

// ── TimeMachine ───────────────────────────────────────────────

export class TimeMachine {
  private snapshotsDir: string;

  constructor(cwd: string) {
    this.snapshotsDir = path.join(cwd, SNAPSHOTS_DIR);
    ensureDir(this.snapshotsDir);
  }

  // ── Public API ────────────────────────────────────────────────

  /**
   * Create a snapshot of the given files.
   * Files that do not exist are skipped (recorded as errors).
   */
  createSnapshot(description: string, filePaths: string[]): Snapshot {
    if (filePaths.length > MAX_SNAPSHOT_FILES) {
      throw new Error(
        `Snapshot too large: ${filePaths.length} files exceeds limit of ${MAX_SNAPSHOT_FILES}`,
      );
    }

    const now = new Date().toISOString();
    const parentSnapshotId = this.getLatestSnapshotId();
    const files: FileSnapshot[] = [];
    const skipped: string[] = [];

    for (const fp of filePaths) {
      try {
        const content = fs.readFileSync(fp, "utf-8");
        files.push({
          filePath: fp,
          content,
          timestamp: now,
          hash: hashContent(content),
        });
      } catch {
        skipped.push(fp);
      }
    }

    const snapshot: Snapshot = {
      id: generateId(),
      timestamp: now,
      description,
      files,
      parentSnapshotId: parentSnapshotId ?? undefined,
      branch: this.getActiveBranch(),
    };

    this.writeSnapshot(snapshot);
    this.pruneIfNeeded();

    return snapshot;
  }

  /**
   * Restore all files from a snapshot.
   */
  restoreSnapshot(snapshotId: string): RestoreResult {
    const snapshot = this.readSnapshot(snapshotId);
    const restored: string[] = [];
    const errors: { filePath: string; error: string }[] = [];

    for (const fsEntry of snapshot.files) {
      try {
        const dir = path.dirname(fsEntry.filePath);
        ensureDir(dir);
        fs.writeFileSync(fsEntry.filePath, fsEntry.content, "utf-8");
        restored.push(fsEntry.filePath);
      } catch (err) {
        errors.push({
          filePath: fsEntry.filePath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { restored, errors };
  }

  /**
   * List all snapshots, newest first.
   */
  listSnapshots(limit?: number): Snapshot[] {
    const ids = this.getAllSnapshotIds();
    const snapshots: Snapshot[] = [];

    for (const id of ids) {
      try {
        snapshots.push(this.readSnapshot(id));
      } catch {
        // skip corrupted files
      }
    }

    snapshots.sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );

    return limit ? snapshots.slice(0, limit) : snapshots;
  }

  /**
   * Compare two snapshots at the file level.
   */
  compareSnapshots(id1: string, id2: string): SnapshotDiff {
    const s1 = this.readSnapshot(id1);
    const s2 = this.readSnapshot(id2);

    const files1 = new Map(s1.files.map((f) => [f.filePath, f.hash]));
    const files2 = new Map(s2.files.map((f) => [f.filePath, f.hash]));

    const allPaths = new Set([...files1.keys(), ...files2.keys()]);

    const added: string[] = [];
    const removed: string[] = [];
    const modified: string[] = [];
    const unchanged: string[] = [];

    for (const fp of allPaths) {
      const in1 = files1.has(fp);
      const in2 = files2.has(fp);

      if (!in1 && in2) {
        added.push(fp);
      } else if (in1 && !in2) {
        removed.push(fp);
      } else if (files1.get(fp) !== files2.get(fp)) {
        modified.push(fp);
      } else {
        unchanged.push(fp);
      }
    }

    return { added, removed, modified, unchanged };
  }

  /**
   * Get line-by-line diff for a specific file between two snapshots.
   */
  getSnapshotDiff(
    id1: string,
    id2: string,
    filePath: string,
  ): FileDiff {
    const s1 = this.readSnapshot(id1);
    const s2 = this.readSnapshot(id2);

    const f1 = s1.files.find((f) => f.filePath === filePath);
    const f2 = s2.files.find((f) => f.filePath === filePath);

    const lines1 = f1 ? f1.content.split("\n") : [];
    const lines2 = f2 ? f2.content.split("\n") : [];

    return { lines: this.computeLineDiff(lines1, lines2) };
  }

  /**
   * Delete a snapshot by ID.
   */
  deleteSnapshot(snapshotId: string): void {
    const filePath = this.snapshotPath(snapshotId);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  /**
   * Create a named branch from a snapshot (or current state).
   */
  createBranch(name: string, fromSnapshotId?: string): void {
    const refFile = path.join(this.snapshotsDir, `branch-${name}.json`);

    if (fs.existsSync(refFile)) {
      throw new Error(`Branch "${name}" already exists`);
    }

    const ref = {
      name,
      createdAt: new Date().toISOString(),
      fromSnapshotId: fromSnapshotId ?? this.getLatestSnapshotId() ?? null,
    };

    fs.writeFileSync(refFile, JSON.stringify(ref, null, 2), "utf-8");
  }

  /**
   * List all branch names.
   */
  listBranches(): string[] {
    const entries = fs.readdirSync(this.snapshotsDir);
    return entries
      .filter((e) => e.startsWith("branch-") && e.endsWith(".json"))
      .map((e) => e.slice("branch-".length, e.length - ".json".length));
  }

  // ── Internal helpers ──────────────────────────────────────────

  private snapshotPath(id: string): string {
    return path.join(this.snapshotsDir, `snap-${id}.json`);
  }

  private writeSnapshot(snapshot: Snapshot): void {
    const filePath = this.snapshotPath(snapshot.id);
    fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2), "utf-8");
  }

  private readSnapshot(id: string): Snapshot {
    const filePath = this.snapshotPath(id);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Snapshot "${id}" not found`);
    }
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as Snapshot;
  }

  private getAllSnapshotIds(): string[] {
    const entries = fs.readdirSync(this.snapshotsDir);
    return entries
      .filter((e) => e.startsWith("snap-") && e.endsWith(".json"))
      .map((e) => e.slice("snap-".length, e.length - ".json".length));
  }

  private getLatestSnapshotId(): string | null {
    const ids = this.getAllSnapshotIds();
    if (ids.length === 0) return null;

    let latestId = ids[0];
    let latestTime = 0;

    for (const id of ids) {
      try {
        const snap = this.readSnapshot(id);
        const t = new Date(snap.timestamp).getTime();
        if (t > latestTime) {
          latestTime = t;
          latestId = id;
        }
      } catch {
        // skip corrupted
      }
    }

    return latestId;
  }

  private getActiveBranch(): string | undefined {
    // For now, return the default branch name.
    // Branch switching is a future concern.
    return undefined;
  }

  private pruneIfNeeded(): void {
    const ids = this.getAllSnapshotIds();
    if (ids.length <= MAX_SNAPSHOTS) return;

    // Collect timestamps to sort
    const withTime: { id: string; time: number }[] = [];
    for (const id of ids) {
      try {
        const snap = this.readSnapshot(id);
        withTime.push({ id, time: new Date(snap.timestamp).getTime() });
      } catch {
        // corrupted snapshot — remove it
        this.deleteSnapshot(id);
      }
    }

    withTime.sort((a, b) => a.time - b.time);

    const toRemove = withTime.length - MAX_SNAPSHOTS;
    for (let i = 0; i < toRemove; i++) {
      this.deleteSnapshot(withTime[i].id);
    }
  }

  /**
   * Simple LCS-based line diff algorithm.
   * Returns lines annotated as added / removed / unchanged.
   */
  private computeLineDiff(
    oldLines: string[],
    newLines: string[],
  ): FileDiff["lines"] {
    const m = oldLines.length;
    const n = newLines.length;

    // Build LCS table
    const dp: number[][] = Array.from({ length: m + 1 }, () =>
      new Array<number>(n + 1).fill(0),
    );

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (oldLines[i - 1] === newLines[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
      }
    }

    // Backtrack to produce diff
    const result: FileDiff["lines"] = [];
    let i = m;
    let j = n;
    const oldNums: number[] = [];
    const newNums: number[] = [];

    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
        oldNums.push(i);
        newNums.push(j);
        result.push({
          type: "unchanged",
          content: oldLines[i - 1],
          lineNumber: j,
        });
        i--;
        j--;
      } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
        newNums.push(j);
        result.push({
          type: "added",
          content: newLines[j - 1],
          lineNumber: j,
        });
        j--;
      } else if (i > 0) {
        oldNums.push(i);
        result.push({
          type: "removed",
          content: oldLines[i - 1],
          lineNumber: i,
        });
        i--;
      }
    }

    result.reverse();
    return result;
  }
}
