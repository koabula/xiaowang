import assert from "node:assert/strict";
import { test } from "node:test";
import { MossVoiceCatalog } from "../desktop/main/moss-voices.ts";
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test("MOSS voices follow every page, deduplicate IDs and preserve unnamed entries", async () => {
  const urls: URL[] = [];
  const catalog = new MossVoiceCatalog(undefined, async (input, options) => {
    const url = new URL(String(input)); urls.push(url); assert.equal((options?.headers as Record<string, string>).Authorization, "Bearer local-key");
    assert.equal(url.searchParams.get("limit"), "150");
    return url.searchParams.has("after") ? response({ data: [{ id: "two", name: "第二个" }, { id: "one", name: "第一个" }], has_more: false })
      : response({ data: [{ id: "one", name: "第一个" }, { id: "unnamed", name: "" }], has_more: true, next_cursor: "opaque cursor" });
  });
  const voices = await catalog.list("local-key"); assert.deepEqual(voices.map(voice => voice.id), ["one", "unnamed", "two"]);
  assert.ok(voices[1]!.name); assert.equal(urls[1]!.searchParams.get("after"), "opaque cursor");
  await catalog.list("local-key"); assert.equal(urls.length, 2);
  await catalog.list("local-key", true); assert.equal(urls.length, 4);
});
test("MOSS voice cache and concurrent requests are scoped to each full credential", async () => {
  let calls = 0;
  const catalog = new MossVoiceCatalog(undefined, async (_input, options) => { calls++; await new Promise(resolve => setTimeout(resolve, 5)); return response({ data: [{ id: (options?.headers as Record<string, string>).Authorization, name: "account" }], has_more: false }); });
  const [a, b] = await Promise.all([catalog.list("first-same-suffix"), catalog.list("first-same-suffix")]); assert.deepEqual(a, b); assert.equal(calls, 1);
  const other = await catalog.list("other-same-suffix"); assert.notDeepEqual(a, other); assert.equal(calls, 2);
});
test("MOSS pagination failures never masquerade as a complete catalog; failures can retry", async () => {
  let broken = true;
  const catalog = new MossVoiceCatalog(undefined, async () => response(broken ? { data: [], has_more: true, next_cursor: "same" } : { data: [{ id: "ok", name: "恢复" }], has_more: false }));
  await assert.rejects(catalog.list("local"), /分页异常/); broken = false; assert.equal((await catalog.list("local"))[0]?.id, "ok");
  await assert.rejects(new MossVoiceCatalog(undefined, async () => response({}, 401)).list("bad-key"), /密钥和权限/);
  await assert.rejects(catalog.list(""), /先填写/);
});
