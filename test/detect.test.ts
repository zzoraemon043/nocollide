import assert from "node:assert/strict";
import { test } from "node:test";
import { detectPorts } from "../src/detect.js";
import { sandbox } from "./helpers.js";

test("detects ports from .env.example and scripts without duplicates", (t) => {
  const box = sandbox({
    ".env.example": "WEB_PORT=3000\nexport API_PORT=\"4000\"\nSECRET=x\n",
    "package.json": JSON.stringify({
      scripts: { dev: "next dev -p 3000", storybook: "storybook dev --port 6006", lint: "eslint ." },
    }),
  });
  t.after(box.cleanup);
  const result = detectPorts(box.repo);
  assert.deepEqual(result.ports, { WEB_PORT: 3000, API_PORT: 4000, STORYBOOK_PORT: 6006 });
  assert.equal(result.envFrom, ".env.example");
  assert.deepEqual(result.hardcoded, ["dev", "storybook"]);
  assert.equal(result.detected, true);
});

test("a single script port becomes PORT", (t) => {
  const box = sandbox({ "package.json": JSON.stringify({ scripts: { start: "PORT=5173 vite" } }) });
  t.after(box.cleanup);
  assert.deepEqual(detectPorts(box.repo).ports, { PORT: 5173 });
});

test("a plain PORT in .env.example is detected", (t) => {
  const box = sandbox({ ".env.example": "PORT=8080\n" });
  t.after(box.cleanup);
  const result = detectPorts(box.repo);
  assert.deepEqual(result.ports, { PORT: 8080 });
  assert.equal(result.detected, true);
});

test("falls back to PORT=3000 when nothing is found", (t) => {
  const box = sandbox();
  t.after(box.cleanup);
  const result = detectPorts(box.repo);
  assert.deepEqual(result.ports, { PORT: 3000 });
  assert.equal(result.detected, false);
  assert.equal(result.envFrom, undefined);
});
