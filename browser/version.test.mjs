import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// cli.mjs restarts the server until both report the same version, so the two file lists must match.
test("cli and server hash the same files", () => {
	const list = (f) => fs.readFileSync(new URL(f, import.meta.url), "utf8").match(/\[("[\w.]+\.mjs"(?:, )?)+\]\.map\(\(f\) => fs\.statSync/)[0];
	assert.equal(list("cli.mjs"), list("server.mjs"));
});
