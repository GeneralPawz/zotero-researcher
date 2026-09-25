import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./harness.mjs";

test("Stop cancels running requests and refuses new ones until resumed", async () => {
  const ZR = load();
  // A transport whose requests only end when they are cancelled
  let started = 0;
  const hanging = (method, url, o) =>
    new Promise((resolve, reject) => {
      started++;
      o.cancellerReceiver?.(() => reject(Object.assign(new Error("cancelled"), { status: 0 })));
    });
  const http = ZR.Activity.wrapHTTP(hanging);
  const a = http("GET", "https://api.example.org/slow").catch((e) => e);
  const b = http("POST", "https://api.example.org/slower").catch((e) => e);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(ZR.Activity.running().length, 2);
  assert.equal(ZR.Activity.stopAll(), 2, "both were cancelled");
  const [ea, eb] = await Promise.all([a, b]);
  assert.equal(ea.stopped, true);
  assert.equal(eb.stopped, true);
  assert.equal(ZR.Activity.running().length, 0);
  // while stopping, nothing new starts
  const c = await http("GET", "https://api.example.org/next").catch((e) => e);
  assert.equal(c.stopped, true);
  assert.equal(started, 2, "the new request never reached the network");
  // after resume, requests work again
  ZR.Activity.resume();
  const ok = ZR.Activity.wrapHTTP(async () => ({ status: 200, text: "{}", json: () => ({}) }));
  assert.equal((await ok("GET", "https://api.example.org/")).status, 200);
});

test("a single running entry can be cancelled from the log", async () => {
  const ZR = load();
  const http = ZR.Activity.wrapHTTP((m, u, o) => new Promise((_, reject) => o.cancellerReceiver(() => reject(Object.assign(new Error("cancelled"), { status: 0 })))));
  const p = http("GET", "https://api.example.org/one").catch((e) => e);
  await new Promise((r) => setTimeout(r, 5));
  const [entry] = ZR.Activity.running();
  assert.ok(ZR.Activity.cancel(entry.id));
  const e = await p;
  assert.equal(e.message, "cancelled", "a single cancel is an error of that request, not a global stop");
  assert.equal(ZR.Activity.stopping, false);
});
