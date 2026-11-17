import assert from "node:assert/strict";
import { test } from "node:test";
import { isAppPage } from "../desktop/main/page-policy.ts";

test("app file document accepts Chromium's equivalent path encoding", () => {
  const entry = "file:///C:/Users/RUNNER%7E1/My%20App/resources/app.asar/renderer/index.html";
  assert.equal(isAppPage(entry.replace("%7E", "~"), entry), true);
  assert.equal(isAppPage(entry + "#task", entry), true);
  assert.equal(isAppPage(entry.replace("index.html", "other.html"), entry), false);
  assert.equal(isAppPage(entry.replace("renderer/index.html", "renderer%2Findex.html"), entry), false);
  assert.equal(isAppPage("https://example.com/renderer/index.html", entry), false);
});

test("app dev document remains restricted to its exact origin and path", () => {
  const entry = "http://localhost:5173/index.html";
  assert.equal(isAppPage(entry + "?task=1", entry), true);
  for (const url of ["http://localhost:5173/other.html", "http://localhost:5173/INDEX.html", "http://localhost:5174/index.html", "https://localhost:5173/index.html", "invalid"]) {
    assert.equal(isAppPage(url, entry), false);
  }
});
