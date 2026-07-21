/**
 * Update checker for klyxor.
 *
 * Checks the npm registry for a newer version of @alnyx/klyxor
 * and displays a notification if an update is available.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ── Types ────────────────────────────────────────────────────

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  packageName: string;
}

// ── Constants ────────────────────────────────────────────────

const PACKAGE_NAME = "@alnyx/klyxor";
const NPM_REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const CHECK_TIMEOUT_MS = 5_000;

// ── Helpers ──────────────────────────────────────────────────

/**
 * Read the current version from package.json.
 * Falls back to "0.0.0" if package.json is not found.
 */
function getCurrentVersion(): string {
  try {
    // Try to find package.json relative to this file
    const pkgPaths = [
      path.join(import.meta.dirname, "..", "package.json"),
      path.join(process.cwd(), "package.json"),
    ];

    for (const pkgPath of pkgPaths) {
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        if (pkg.version) return pkg.version;
      }
    }
  } catch {
    // Ignore errors
  }
  return "0.0.0";
}

/**
 * Compare two semver strings.
 * Returns: -1 if a < b, 0 if equal, 1 if a > b.
 */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);

  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  return 0;
}

/**
 * Fetch the latest version from npm registry.
 * Returns null on any error (network, timeout, etc).
 */
async function fetchLatestVersion(): Promise<string | null> {
  try {
    const resp = await fetch(NPM_REGISTRY_URL, {
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });

    if (!resp.ok) return null;

    const data = (await resp.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

// ── Public API ───────────────────────────────────────────────

/**
 * Check for available updates.
 * Returns UpdateInfo with comparison results.
 */
export async function checkForUpdate(): Promise<UpdateInfo> {
  const currentVersion = getCurrentVersion();
  const latestVersion = await fetchLatestVersion();

  const info: UpdateInfo = {
    currentVersion,
    latestVersion: latestVersion ?? currentVersion,
    updateAvailable: false,
    packageName: PACKAGE_NAME,
  };

  if (latestVersion && compareVersions(latestVersion, currentVersion) > 0) {
    info.updateAvailable = true;
  }

  return info;
}

/**
 * Format an update notification message.
 * Returns null if no update is available.
 */
export function formatUpdateNotification(info: UpdateInfo): string | null {
  if (!info.updateAvailable) return null;

  return [
    `📦 Update available: ${info.currentVersion} → ${info.latestVersion}`,
    `   Run: npm install -g ${info.packageName}@latest`,
  ].join("\n");
}

/**
 * Check for update and return formatted notification (or null).
 * Convenience function combining check + format.
 */
export async function getUpdateNotification(): Promise<string | null> {
  const info = await checkForUpdate();
  return formatUpdateNotification(info);
}
