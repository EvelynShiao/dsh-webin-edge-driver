/** Only this worker performs synchronous profile I/O. Never decrypt cookie values. */
import { parentPort } from "node:worker_threads";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

function probe({ profileDir, dir, rules }) {
  let db;
  try {
    const file = [join(profileDir, "Default", "Network", "Cookies"),
      join(profileDir, "Default", "Cookies"), join(profileDir, "Cookies")].find(existsSync);
    if (!file) return null;
    // Unique per task, mode 0700. Never reuse old WAL/SHM or copy source SHM.
    // Live main+WAL copying is best effort, NOT an atomic SQLite snapshot.
    mkdirSync(dir, { mode: 0o700 });
    const target = join(dir, "Cookies");
    copyFileSync(file, target);
    if (existsSync(file + "-wal")) copyFileSync(file + "-wal", target + "-wal");
    const { DatabaseSync } = require("node:sqlite");
    db = new DatabaseSync(target, { timeout: 100 });
    db.exec("PRAGMA busy_timeout=100");
    const rows = db.prepare("SELECT host_key AS host, name, length(encrypted_value) AS elen FROM cookies").all()
      .map((r) => ({ host: String(r.host ?? ""), name: String(r.name ?? ""), elen: Number(r.elen ?? 0) }));
    const results = {};
    for (const [platform, rule] of Object.entries(rules)) {
      const found = rows.find((r) => {
        const host = r.host.replace(/^\./, "").toLowerCase();
        return r.elen >= 20 && (host === rule.hostSuffix || host.endsWith("." + rule.hostSuffix))
          && rule.names.includes(r.name);
      });
      results[platform] = found ? { loggedIn: true, reason: "cookie", cookie: found.name }
        : { loggedIn: false, reason: "no-login-cookie" };
    }
    return { rows, results };
  } catch { return null; }
  finally {
    try { db?.close(); } catch {}
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}
parentPort.on("message", (task) => parentPort.postMessage({ id: task.id, value: probe(task) }));
