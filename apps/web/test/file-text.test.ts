import assert from "node:assert/strict";
import { test } from "node:test";
import {
  baseName,
  formatBytes,
  fromEditable,
  joinPath,
  lineCount,
  newFileNameProblem,
  parentPath,
  pathSteps,
  toEditable,
} from "../src/lib/file-text.ts";

test("a file is saved with the line endings and byte order mark it had, whatever the text box did to them", () => {
  const lf = "a\nb\n";
  assert.deepEqual(toEditable(lf), { value: lf, eol: "\n", bom: false });
  assert.equal(fromEditable(toEditable(lf).value, toEditable(lf)), lf);

  const win = "﻿一\r\n二\r\n";
  const e = toEditable(win);
  assert.deepEqual(e, { value: "一\n二\n", eol: "\r\n", bom: true });
  assert.equal(fromEditable(e.value, e), win);
  // A line typed in the text box ends like the others.
  assert.equal(fromEditable(`${e.value}三\n`, e), "﻿一\r\n二\r\n三\r\n");
  // Whatever the box gives back ("\r\n" pasted in), the file gets its own endings.
  assert.equal(fromEditable("x\r\ny\rz", { eol: "\n", bom: false }), "x\ny\nz");

  // Mixed: the ending most lines have.
  assert.equal(toEditable("a\r\nb\r\nc\n").eol, "\r\n");
  assert.equal(toEditable("a\nb\nc\r\n").eol, "\n");
  assert.equal(toEditable("").eol, "\n");
});

test("paths inside the session's folder are joined and taken apart by slashes", () => {
  assert.equal(joinPath("", "a.md"), "a.md");
  assert.equal(joinPath("src/lib", "a.ts"), "src/lib/a.ts");
  assert.equal(parentPath("src/lib/a.ts"), "src/lib");
  assert.equal(parentPath("a.ts"), "");
  assert.equal(baseName("src/lib/a.ts"), "a.ts");
  assert.equal(baseName("a.ts"), "a.ts");
  assert.deepEqual(pathSteps(""), []);
  assert.deepEqual(pathSteps("apps/web/src"), [
    ["apps", "apps"],
    ["web", "apps/web"],
    ["src", "apps/web/src"],
  ]);
});

test("sizes and line counts read naturally", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1023), "1023 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(200 * 1024), "200 KB");
  assert.equal(formatBytes(3.25 * 1024 * 1024), "3.3 MB");
  // Just over 1 MB is not "1.0 MB".
  assert.equal(formatBytes(1024 * 1024), "1.0 MB");
  assert.equal(formatBytes(1_100_000), "1.1 MB");
  assert.equal(formatBytes(1024 * 1024 + 1), "1.1 MB");
  assert.equal(lineCount(""), 0);
  assert.equal(lineCount("a"), 1);
  assert.equal(lineCount("a\n"), 1);
  assert.equal(lineCount("a\nb"), 2);
});

test("a new file's name is one name, without spaces around it or control characters", () => {
  for (const ok of ["memo.md", ".env.local", "日本語のメモ.txt", "a b.txt", "-x"]) assert.equal(newFileNameProblem(ok), undefined, ok);
  assert.match(newFileNameProblem("") ?? "", /入れて/);
  assert.match(newFileNameProblem("  ") ?? "", /入れて/);
  assert.match(newFileNameProblem(" a.md") ?? "", /空白/);
  assert.match(newFileNameProblem("..") ?? "", /使えません/);
  assert.match(newFileNameProblem("docs/a.md") ?? "", /\//);
  assert.match(newFileNameProblem("a\tb") ?? "", /制御文字/);
  assert.match(newFileNameProblem("あ".repeat(86)) ?? "", /長すぎ/);
});
