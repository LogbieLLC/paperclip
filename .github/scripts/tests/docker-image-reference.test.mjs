import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../../workflows/docker.yml", import.meta.url), "utf8");
const build = workflow.split("  build-and-push:")[1]?.split("  merge-and-push:")[0];
const merge = workflow.split("  merge-and-push:")[1]?.split("  promote_canary_channel:")[0];
const promote = workflow.split("  promote_canary_channel:")[1];

test("Docker build and manifest jobs use lowercase GHCR image references", () => {
  assert.ok(build);
  assert.ok(merge);
  for (const job of [build, merge]) {
    assert.match(job, /name=ghcr\.io\/\$\{GITHUB_REPOSITORY,,\}/);
    assert.match(job, /images: \$\{\{ steps\.image\.outputs\.name \}\}/);
    assert.doesNotMatch(job, /ghcr\.io\/\$\{\{ github\.repository \}\}/);
  }
  assert.match(build, /outputs: type=image,name=\$\{\{ steps\.image\.outputs\.name \}\},push-by-digest=true/);
  assert.match(build, /cache-from: type=registry,ref=\$\{\{ steps\.image\.outputs\.name \}\}:buildcache-\$\{\{ matrix\.arch \}\}/);
  assert.match(build, /cache-to: type=registry,ref=\$\{\{ steps\.image\.outputs\.name \}\}:buildcache-\$\{\{ matrix\.arch \}\},mode=max/);
  assert.match(merge, /printf '\$\{\{ steps\.image\.outputs\.name \}\}@sha256:%s '/);
  assert.match(promote, /IMAGE="\$\{IMAGE,,\}"/);
});
