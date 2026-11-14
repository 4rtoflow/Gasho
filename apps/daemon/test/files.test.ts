// The files of a session's folder: what is listed, what is read (text as it is, images, or why not), what is written
// (only over the version that was read, in place, and never over something when making a new file), and that nothing
// outside the folder is reached, through ".." or through a symbolic link.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { DirListing, FileContent, FileStamp } from "@gasho/protocol";
import { decodeText, type Failed, listDir, MAX_ENTRIES, MAX_TEXT_BYTES, readFileAt, relPathProblem, sha256, writeFileAt } from "../src/files.ts";

async function tmp(): Promise<{ root: string; outside: string; done: () => Promise<void> }> {
  const top = await fs.mkdtemp(path.join(os.tmpdir(), "gasho-files-"));
  const root = path.join(top, "session");
  const outside = path.join(top, "outside");
  await fs.mkdir(root);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "secret.txt"), "外のファイル");
  return { root, outside, done: () => fs.rm(top, { recursive: true, force: true }) };
}

function ok<T extends object>(r: T | Failed): T {
  if ("error" in r) assert.fail(r.error);
  return r;
}

function failed(r: object): Failed {
  assert.ok("error" in r, `expected an error, got ${JSON.stringify(r).slice(0, 200)}`);
  return r as Failed;
}

test("a path is taken from the session's folder, without a leading /, empty parts, . or ..", () => {
  for (const good of ["", "a", "src/app.ts", ".claude/settings.json", "日本語/メモ.md", "a b/c", "..foo", "foo.."]) {
    assert.equal(relPathProblem(good), undefined, good);
  }
  for (const bad of ["/etc/passwd", "..", "../x", "a/../../x", "a//b", "a/", "./a", "a/.", "a\0b", "x".repeat(4097), 3, undefined]) {
    assert.ok(relPathProblem(bad), JSON.stringify(bad));
  }
});

test("a folder lists folders first, then files by name with their sizes, without .git", async () => {
  const { root, done } = await tmp();
  try {
    await fs.mkdir(path.join(root, "src"));
    await fs.mkdir(path.join(root, ".git"));
    await fs.mkdir(path.join(root, ".claude"));
    await fs.writeFile(path.join(root, "README.md"), "# Gasho\n");
    await fs.writeFile(path.join(root, "file10.txt"), "");
    await fs.writeFile(path.join(root, "file2.txt"), "12");
    const dir: DirListing = ok(await listDir(root, ""));
    assert.equal(dir.path, "");
    assert.equal(dir.truncated, false);
    assert.deepEqual(
      dir.entries.map((e) => [e.name, e.kind]),
      [
        [".claude", "dir"],
        ["src", "dir"],
        ["file2.txt", "file"],
        ["file10.txt", "file"],
        ["README.md", "file"],
      ],
    );
    const readme = dir.entries.find((e) => e.name === "README.md");
    assert.equal(readme?.size, 8);
    assert.ok(readme?.mtime && Math.abs(readme.mtime - Date.now()) < 60_000);
    assert.deepEqual(ok(await listDir(root, "src")), { path: "src", entries: [], truncated: false });
  } finally {
    await done();
  }
});

test("links are listed as what they point to; one outside the folder, or broken, is marked and not opened", async () => {
  const { root, outside, done } = await tmp();
  try {
    await fs.mkdir(path.join(root, "docs"));
    await fs.writeFile(path.join(root, "docs", "a.md"), "abc");
    await fs.symlink("docs", path.join(root, "docs-link"));
    await fs.symlink("docs/a.md", path.join(root, "a-link.md"));
    await fs.symlink(outside, path.join(root, "out"));
    await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "secret.txt"));
    await fs.symlink("nowhere", path.join(root, "broken"));
    const dir = ok(await listDir(root, ""));
    const byName = Object.fromEntries(dir.entries.map((e) => [e.name, e]));
    assert.deepEqual(byName["docs-link"], { name: "docs-link", kind: "dir", link: true });
    assert.equal(byName["a-link.md"]?.kind, "file");
    assert.equal(byName["a-link.md"]?.size, 3);
    assert.deepEqual(byName.out, { name: "out", kind: "dir", link: true, outside: true });
    assert.deepEqual(byName["secret.txt"], { name: "secret.txt", kind: "file", link: true, outside: true });
    assert.deepEqual(byName.broken, { name: "broken", kind: "other", link: true });

    // A link inside the folder is followed; one outside is not, for listing, reading or writing.
    assert.deepEqual(
      ok(await listDir(root, "docs-link")).entries.map((e) => e.name),
      ["a.md"],
    );
    assert.equal(ok(await readFileAt(root, "a-link.md")).text, "abc");
    assert.match(failed(await listDir(root, "out")).error, /外を指すリンク/);
    assert.match(failed(await readFileAt(root, "secret.txt")).error, /外を指すリンク/);
    assert.match(failed(await readFileAt(root, "out/secret.txt")).error, /外を指すリンク/);
    assert.match(failed(await writeFileAt(root, "secret.txt", "上書き")).error, /外を指すリンク/);
    assert.match(failed(await writeFileAt(root, "out/new.txt", "x", { create: true })).error, /外を指すリンク/);
    assert.equal(await fs.readFile(path.join(outside, "secret.txt"), "utf8"), "外のファイル");
    await assert.rejects(fs.stat(path.join(outside, "new.txt")));
    // ".." never reaches the folder above.
    assert.match(failed(await readFileAt(root, "../outside/secret.txt")).error, /フォルダーの中のパス/);
    assert.match(failed(await listDir(root, "docs/../..")).error, /フォルダーの中のパス/);
  } finally {
    await done();
  }
});

test("a huge folder is cut at the limit, folders first", async () => {
  const { root, done } = await tmp();
  try {
    await fs.mkdir(path.join(root, "zz-folder"));
    await Promise.all(Array.from({ length: MAX_ENTRIES + 5 }, (_, i) => fs.writeFile(path.join(root, `f${i}`), "")));
    const dir = ok(await listDir(root, ""));
    assert.equal(dir.truncated, true);
    assert.equal(dir.entries.length, MAX_ENTRIES);
    assert.equal(dir.entries[0]?.name, "zz-folder");
    assert.equal(dir.entries[1]?.name, "f0");
  } finally {
    await done();
  }
});

test("what is not a folder, or not there, is said in words", async () => {
  const { root, done } = await tmp();
  try {
    await fs.writeFile(path.join(root, "a.txt"), "a");
    assert.match(failed(await listDir(root, "a.txt")).error, /フォルダーではありません/);
    assert.match(failed(await listDir(root, "missing")).error, /見つかりません/);
    assert.match(failed(await readFileAt(root, "missing.txt")).error, /見つかりません/);
    assert.match(failed(await readFileAt(root, "")).error, /ファイルを指定/);
    await fs.mkdir(path.join(root, "src"));
    assert.match(failed(await readFileAt(root, "src")).error, /フォルダーです/);
    assert.match(failed(await listDir(path.join(root, "gone"), "")).error, /セッションのフォルダーがありません/);
  } finally {
    await done();
  }
});

test("text is read as it is, with its byte order mark and line endings, and its hash", async () => {
  const { root, done } = await tmp();
  try {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("一行目\r\n二行目\r\n")]);
    await fs.writeFile(path.join(root, "win.txt"), bytes);
    const file: FileContent = ok(await readFileAt(root, "win.txt"));
    assert.equal(file.text, "﻿一行目\r\n二行目\r\n");
    assert.equal(file.size, bytes.length);
    assert.equal(file.hash, sha256(bytes));
    assert.equal(file.writable, true);
    assert.equal(file.binary, undefined);
    // An empty file is text too.
    await fs.writeFile(path.join(root, "empty"), "");
    assert.equal(ok(await readFileAt(root, "empty")).text, "");
  } finally {
    await done();
  }
});

test("binary files, text that is not UTF-8, and files too large are not sent; images are", async () => {
  const { root, done } = await tmp();
  try {
    await fs.writeFile(path.join(root, "a.bin"), Buffer.from([1, 2, 0, 3]));
    await fs.writeFile(path.join(root, "sjis.txt"), Buffer.from([0x82, 0xa0, 0x82, 0xa2])); // "あい" in Shift_JIS
    await fs.writeFile(path.join(root, "big.log"), Buffer.alloc(MAX_TEXT_BYTES + 1, 0x61));
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    await fs.writeFile(path.join(root, "shot.PNG"), png);
    const bin = ok(await readFileAt(root, "a.bin"));
    assert.equal(bin.binary, true);
    assert.equal(bin.text, undefined);
    assert.equal(ok(await readFileAt(root, "sjis.txt")).binary, true);
    const big = ok(await readFileAt(root, "big.log"));
    assert.equal(big.tooLarge, true);
    assert.equal(big.size, MAX_TEXT_BYTES + 1);
    assert.equal(big.text, undefined);
    assert.equal(big.hash, undefined);
    assert.deepEqual(ok(await readFileAt(root, "shot.PNG")).image, { mime: "image/png", data: png.toString("base64") });
    // SVG is text.
    await fs.writeFile(path.join(root, "logo.svg"), "<svg/>");
    assert.equal(ok(await readFileAt(root, "logo.svg")).text, "<svg/>");
    assert.equal(decodeText(Buffer.from("ok")), "ok");
  } finally {
    await done();
  }
});

test("a read-only file says so", { skip: process.getuid?.() === 0 }, async () => {
  const { root, done } = await tmp();
  try {
    await fs.writeFile(path.join(root, "ro.txt"), "x", { mode: 0o444 });
    assert.equal(ok(await readFileAt(root, "ro.txt")).writable, false);
    assert.match(failed(await writeFileAt(root, "ro.txt", "y")).error, /書き込む権限/);
  } finally {
    await done();
  }
});

test("a file is written over the version that was read, in place; a file changed meanwhile is not", async () => {
  const { root, done } = await tmp();
  try {
    const file = path.join(root, "run.sh");
    await fs.writeFile(file, "echo 1\n", { mode: 0o755 });
    await fs.symlink("run.sh", path.join(root, "run-link.sh"));
    const read = ok(await readFileAt(root, "run.sh"));
    const stamp: FileStamp = ok(await writeFileAt(root, "run.sh", "echo 2\n", { baseHash: read.hash }));
    assert.equal(await fs.readFile(file, "utf8"), "echo 2\n");
    assert.equal(stamp.hash, sha256(Buffer.from("echo 2\n")));
    assert.equal(stamp.size, 7);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o755);

    // Claude changed it after it was read: nothing is written.
    await fs.writeFile(file, "echo 3\n");
    const stale = failed(await writeFileAt(root, "run.sh", "echo 4\n", { baseHash: stamp.hash }));
    assert.equal(stale.conflict, true);
    assert.equal(await fs.readFile(file, "utf8"), "echo 3\n");
    // Asked to overwrite (no hash), it does.
    ok(await writeFileAt(root, "run.sh", "echo 4\n"));
    assert.equal(await fs.readFile(file, "utf8"), "echo 4\n");

    // Through a link inside the folder, the file it points to is written, and the link stays a link.
    ok(await writeFileAt(root, "run-link.sh", "echo 5\n"));
    assert.equal(await fs.readFile(file, "utf8"), "echo 5\n");
    assert.ok((await fs.lstat(path.join(root, "run-link.sh"))).isSymbolicLink());

    assert.match(failed(await writeFileAt(root, "missing.txt", "x")).error, /見つかりません/);
    assert.match(failed(await writeFileAt(root, "", "x")).error, /ファイルを指定/);
    assert.match(failed(await writeFileAt(root, "../x.txt", "x", { create: true })).error, /フォルダーの中のパス/);
    assert.match(failed(await writeFileAt(root, "run.sh", "あ".repeat(MAX_TEXT_BYTES / 3 + 1))).error, /1MB/);
    assert.equal(await fs.readFile(file, "utf8"), "echo 5\n");
  } finally {
    await done();
  }
});

test("a new file is made in a folder that is there, and never over anything already there", async () => {
  const { root, done } = await tmp();
  try {
    await fs.mkdir(path.join(root, "notes"));
    await fs.writeFile(path.join(root, "taken.md"), "前からある");
    await fs.symlink("nowhere", path.join(root, "dangling"));
    const made = ok(await writeFileAt(root, "notes/今日.md", "", { create: true }));
    assert.equal(made.size, 0);
    assert.equal(await fs.readFile(path.join(root, "notes", "今日.md"), "utf8"), "");
    assert.match(failed(await writeFileAt(root, "taken.md", "x", { create: true })).error, /すでにあります/);
    assert.equal(await fs.readFile(path.join(root, "taken.md"), "utf8"), "前からある");
    assert.match(failed(await writeFileAt(root, "notes", "x", { create: true })).error, /すでにあります/);
    // Not even through a broken link.
    assert.match(failed(await writeFileAt(root, "dangling", "x", { create: true })).error, /すでにあります/);
    await assert.rejects(fs.stat(path.join(root, "nowhere")));
    assert.match(failed(await writeFileAt(root, "missing/a.md", "x", { create: true })).error, /見つかりません/);
    assert.match(failed(await writeFileAt(root, "taken.md/a.md", "x", { create: true })).error, /フォルダーではありません|見つかりません/);
    assert.match(failed(await writeFileAt(root, " a.md", "x", { create: true })).error, /空白/);
    assert.match(failed(await writeFileAt(root, "a\nb.md", "x", { create: true })).error, /改行/);
  } finally {
    await done();
  }
});
