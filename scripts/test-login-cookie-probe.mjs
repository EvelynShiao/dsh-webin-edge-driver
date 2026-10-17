import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { createCookieProbe } from "../lib/login-cookie-probe.js";

const root = mkdtempSync(join(tmpdir(), "webin-synthetic-test-"));
function database(name, layout, rows = [], wal = false) {
  const profile = join(root, name);
  const file = join(profile, layout);
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE cookies (host_key TEXT, name TEXT, encrypted_value BLOB)");
  if (wal) db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
  for (const [host, cookie, length = 32] of rows)
    db.prepare("INSERT INTO cookies VALUES (?,?,?)").run(host, cookie, Buffer.alloc(length, 42));
  if (!wal) db.close();
  return { profile, file, db: wal ? db : undefined };
}
// An explicitly awaited unref worker is deliberately not a process-liveness claim.
const keepAlive = setInterval(() => {}, 1000);
try {
  await test("synthetic layouts, async first result, account/platform isolation and cache", async () => {
    const probe = createCookieProbe();
    try {
      for (const [i, layout] of ["Default/Network/Cookies", "Default/Cookies", "Cookies"].entries()) {
        const { profile } = database(`layout-${i}`, layout, [[".deepseek.com", "ds_session_id"]]);
        assert.deepEqual(probe.isLoggedInByCookies("deepseek", profile),
          { loggedIn: false, reason: "profile-pending", status: "pending" });
        const [a, b] = await Promise.all([probe.waitForCookieProbe("deepseek", profile), probe.waitForCookieProbe("deepseek", profile)]);
        assert.equal(a.loggedIn, true);
        assert.deepEqual(a, b);
        assert.equal(probe.isLoggedInByCookies("qwen", profile).loggedIn, false);
        assert.equal(probe.isLoggedInByCookies("deepseek", profile).loggedIn, true);
      }
      const empty = database("empty", "Cookies").profile;
      assert.equal((await probe.waitForCookieProbe("deepseek", empty)).reason, "no-login-cookie");
      const spoof = database("spoof", "Cookies", [["evil-deepseek.com", "ds_session_id"], ["deepseek.com", "ds_session_id", 1]]).profile;
      assert.equal((await probe.waitForCookieProbe("deepseek", spoof)).loggedIn, false);
      assert.equal(probe.isLoggedInByCookies("custom", empty).reason, "no-rule");
      assert.equal(probe.isLoggedInByCookies("toString", empty).reason, "no-rule");
    } finally { await probe.close(); }
  });
  await test("missing/corrupt profiles return unknown; no synchronous copy/stat/SQLite in host", async () => {
    const probe = createCookieProbe();
    try {
      const broken = join(root, "broken");
      mkdirSync(broken); writeFileSync(join(broken, "Cookies"), "not sqlite");
      for (const profile of [broken, join(root, "missing")]) {
        assert.equal((await probe.waitForCookieProbe("deepseek", profile)).reason, "profile-unreadable");
        assert.equal(probe.isLoggedInByCookies("deepseek", profile).status, "unknown");
      }
      // Independent child poisons host sync filesystem methods only. Worker has
      // its own module context; a synchronous regression fails immediately.
      const moduleURL = new URL("../lib/login-cookie-probe.js", import.meta.url).href;
      await runChild(`import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
        for (const key of ['copyFileSync','existsSync','statSync','mkdirSync']) fs[key]=()=>{throw Error('host sync IO '+key)};
        syncBuiltinESMExports();
        const {isLoggedInByCookies}=await import(${JSON.stringify(moduleURL)});
        const r=isLoggedInByCookies('deepseek',${JSON.stringify(broken)});
        if(r.status!=='pending') throw Error(JSON.stringify(r));`);
    } finally { await probe.close(); }
  });
  await test("fresh copies include live WAL, never reuse vanished WAL/SHM", async () => {
    const source = database("wal", "Cookies", [["deepseek.com", "ds_session_id"]], true);
    const probe = createCookieProbe({ ttlMs: 20 });
    try {
      assert.equal(existsSync(source.file + "-wal"), true);
      assert.equal((await probe.waitForCookieProbe("deepseek", source.profile)).loggedIn, true);
      source.db.exec("DELETE FROM cookies; PRAGMA wal_checkpoint(TRUNCATE)");
      source.db.close();
      await new Promise((r) => setTimeout(r, 30));
      assert.equal((await probe.waitForCookieProbe("deepseek", source.profile)).reason, "no-login-cookie");
    } finally { await probe.close(); }
  });
  await test("bounded queue, timeout cooldown, event-loop progress, explicit cleanup", async () => {
    const slowURL = new URL("./fixtures/login-cookie-probe-slow-worker.mjs", import.meta.url);
    const probe = createCookieProbe({ workerURL: slowURL, maxQueue: 1, timeoutMs: 150, failureTtlMs: 10000 });
    try {
      const first = probe.waitForCookieProbe("deepseek", join(root, "slow-1"));
      const second = probe.waitForCookieProbe("deepseek", join(root, "slow-2"));
      assert.equal(probe.isLoggedInByCookies("deepseek", join(root, "overflow")).status, "unknown");
      let ticks = 0;
      const heartbeat = setInterval(() => ticks++, 5);
      const result = await first;
      clearInterval(heartbeat);
      assert.ok(ticks >= 3, `heartbeat ticks=${ticks}`);
      assert.equal(result.status, "unknown");
      assert.equal((await second).status, "unknown");
      for (let i = 0; i < 100; i++) assert.equal(probe.isLoggedInByCookies("deepseek", join(root, `again-${i}`)).status, "unknown");
    } finally { await probe.close(); }
  });
  await test("worker startup failure and close settle pending callers", async () => {
    const bad = createCookieProbe({ workerURL: new URL('./fixtures/absent-worker.mjs', import.meta.url) });
    try {
      assert.equal((await bad.waitForCookieProbe('deepseek', join(root, 'error'))).status, 'unknown');
      assert.equal(bad.isLoggedInByCookies('deepseek', join(root, 'error2')).status, 'unknown');
    } finally { await bad.close(); }
    const slow = createCookieProbe({ workerURL: new URL('./fixtures/login-cookie-probe-slow-worker.mjs', import.meta.url) });
    const requests = ['cancel1', 'cancel2'].map(name => slow.waitForCookieProbe('deepseek', join(root, name)));
    await slow.close();
    for (const result of await Promise.all(requests)) assert.equal(result.status, 'unknown');
  });
  await test("unref worker and timeout do not keep a host process alive", async () => {
    const moduleURL = new URL("../lib/login-cookie-probe.js", import.meta.url).href;
    const slowURL = new URL("./fixtures/login-cookie-probe-slow-worker.mjs", import.meta.url).href;
    await runChild(`import {createCookieProbe} from ${JSON.stringify(moduleURL)};
      const p=createCookieProbe({workerURL:new URL(${JSON.stringify(slowURL)}),timeoutMs:60000});
      p.isLoggedInByCookies('deepseek','/synthetic-only');`);
  });
} finally {
  clearInterval(keepAlive);
  // root is a freshly-created synthetic directory, never a browser profile.
  assert.ok(root.startsWith(join(tmpdir(), "webin-synthetic-test-")));
  rmSync(root, { recursive: true, force: true });
}
function runChild(code) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (x) => stderr += x);
    const timeout = setTimeout(() => { child.kill(); reject(Error("child prevented exit")); }, 2500);
    child.on("error", reject);
    child.on("exit", (code) => { clearTimeout(timeout); code === 0 ? resolve() : reject(Error(stderr)); });
  });
}
