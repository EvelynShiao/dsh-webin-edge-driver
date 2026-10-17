/** Synchronous host API, asynchronous disk/SQLite probe. No profile I/O on this thread.
 * Cold/expired entries fail closed until a later call observes the worker result.
 * Cookie presence is a heuristic, not server-side verification of a session.
 */
import { Worker } from "node:worker_threads";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";

export const LOGIN_COOKIE_RULES = {
  yuanbao: { hostSuffix: "tencent.com", names: ["hy_token", "hy_user"] },
  qwen: { hostSuffix: "qianwen.com", names: ["tongyi_sso_ticket", "tongyi_sso_ticket_hash"] },
  doubao: { hostSuffix: "doubao.com", names: ["sid_guard", "sessionid", "sessionid_ss"] },
  deepseek: { hostSuffix: "deepseek.com", names: ["ds_session_id"] },
};
const pending = Object.freeze({ loggedIn: false, reason: "profile-pending", status: "pending" });
const unknown = Object.freeze({ loggedIn: false, reason: "profile-unreadable", status: "unknown" });
const noRule = Object.freeze({ loggedIn: false, reason: "no-rule" });

/** Separate instances allow synthetic tests without touching the host singleton.
 * At most one worker and maxQueue waiting profiles; no retry timer. Failures are
 * cached and worker-level failures impose a global cooldown. All timers/workers
 * are unref'ed. Expired positives are NOT returned while refreshing.
 */
export function createCookieProbe({ ttlMs = 5000, failureTtlMs = 30000,
  timeoutMs = 3000, maxQueue = 32, maxCache = 64,
  workerURL = new URL("./login-cookie-probe-worker.js", import.meta.url) } = {}) {
  const cache = new Map();
  const queue = [];
  let worker, active, timer, closed = false, cooldownUntil = 0;
  function finish(entry, value) {
    entry.pending = false;
    entry.complete?.();
    entry.value = value;
    entry.until = Date.now() + (value === null ? failureTtlMs : ttlMs);
  }
  function cleanup(dir) { return rm(dir, { recursive: true, force: true }).catch(() => {}); }
  function retire() {
    const old = worker;
    worker = undefined;
    return old ? old.terminate().catch(() => {}) : Promise.resolve();
  }
  function fail() {
    clearTimeout(timer);
    const dir = active?.dir;
    if (active) finish(active.entry, null);
    active = undefined;
    for (const entry of queue.splice(0)) finish(entry, null);
    cooldownUntil = Date.now() + failureTtlMs;
    void retire().then(() => dir && cleanup(dir));
  }
  function pump() {
    if (closed || active || !queue.length) return;
    if (!worker) {
      try {
        worker = new Worker(workerURL);
        const current = worker;
        worker.on("message", (message) => {
          if (worker !== current || !active || message.id !== active.id) return;
          clearTimeout(timer);
          const { entry, dir } = active;
          finish(entry, message.value ?? null);
          active = undefined;
          void cleanup(dir);
          if (queue.length) pump();
          else void retire();
        });
        worker.on("error", () => { if (worker === current) fail(); });
        worker.on("exit", () => { if (worker === current) fail(); });
        worker.unref();
      } catch { fail(); return; }
    }
    const entry = queue.shift();
    const id = randomUUID();
    active = { entry, id, dir: join(tmpdir(), `webin-cookie-probe-${id}`) };
    timer = setTimeout(fail, timeoutMs);
    timer.unref();
    try {
      worker.postMessage({ id, profileDir: entry.key, dir: active.dir, rules: LOGIN_COOKIE_RULES });
    } catch { fail(); }
  }
  function lookup(profileDir) {
    if (closed || typeof profileDir !== "string" || !profileDir) return null;
    const key = resolve(profileDir); // lexical normalization only, never realpath/stat
    let entry = cache.get(key);
    if (entry?.pending) return undefined;
    if (entry && Date.now() < entry.until) return entry.value;
    if (Date.now() < cooldownUntil || queue.length >= maxQueue) return null;
    if (!entry) {
      if (cache.size >= maxCache) {
        const victim = [...cache.values()].find((item) => !item.pending);
        if (!victim) return null;
        cache.delete(victim.key);
      }
      entry = { key };
      cache.set(key, entry);
    }
    entry.pending = true;
    entry.promise = new Promise((complete) => { entry.complete = complete; });
    queue.push(entry);
    pump();
    return undefined;
  }
  const api = {
    async waitForCookieProbe(platformId, profileDir) {
      const initial = api.isLoggedInByCookies(platformId, profileDir);
      if (initial.status !== "pending") return initial;
      await cache.get(resolve(profileDir))?.promise;
      return api.isLoggedInByCookies(platformId, profileDir);
    },
    isLoggedInByCookies(platformId, profileDir) {
      if (!Object.hasOwn(LOGIN_COOKIE_RULES, platformId)) return noRule;
      const value = lookup(profileDir);
      return value === undefined ? pending : value === null ? unknown
        : { ...value.results[platformId] };
    },
    // Legacy export remains synchronous: null means pending OR unreadable.
    readProfileCookies(profileDir) {
      return lookup(profileDir)?.rows?.map((row) => ({ ...row })) ?? null;
    },
    async close() {
      closed = true;
      clearTimeout(timer);
      const dir = active?.dir;
      active = undefined;
      queue.length = 0;
      for (const entry of cache.values()) entry.complete?.();
      cache.clear();
      await retire();
      if (dir) await cleanup(dir);
    },
  };
  return api;
}
const defaultProbe = createCookieProbe();
export const isLoggedInByCookies = defaultProbe.isLoggedInByCookies;
export const readProfileCookies = defaultProbe.readProfileCookies;
export const waitForCookieProbe = defaultProbe.waitForCookieProbe;
