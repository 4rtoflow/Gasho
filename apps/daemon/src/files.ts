// The files of a session's folder, for the Gasho screen: the entries of a folder in it, a file's text (or an image's
// data), and a text file written back or made. Paths come from the session's folder ("src/app.ts") and must stay in
// it once symbolic links are followed: a link that points outside the folder is listed, but neither read nor written.
import { createHash } from "node:crypto";
import { constants, type Dirent, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { DirEntry, DirListing, FileContent, FileStamp } from "@gasho/protocol";

/** Text larger than this is neither sent nor written. */
export const MAX_TEXT_BYTES = 1024 * 1024;
/** Images up to this size are sent, to be shown. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** The entries of one folder that are sent at most. */
export const MAX_ENTRIES = 2000;
const MAX_PATH = 4096;
/** The longest name of a file, in bytes, as file systems count them. */
const MAX_NAME_BYTES = 255;
/** Not listed: Git's own data. */
const HIDDEN = new Set([".git"]);
/** How much of a file is looked at for a NUL byte, which text files do not hold (as Git does). */
const SNIFF_BYTES = 8000;

/** Images shown as pictures, by their extension. SVG is text, and is opened as text. */
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
};

/** Why something could not be done, for the person who asked. `conflict`: see writeFileAt. */
export type Failed = { error: string; conflict?: boolean };

/** Why `rel` cannot name something inside a session's folder, or undefined. "" is the folder itself. */
export function relPathProblem(rel: unknown): string | undefined {
  if (typeof rel !== "string" || rel.length > MAX_PATH || rel.includes("\0")) return "パスの指定が正しくありません。";
  if (rel === "") return undefined;
  if (rel.startsWith("/") || rel.split("/").some((p) => p === "" || p === "." || p === "..")) {
    return "セッションのフォルダーの中のパスを指定してください。";
  }
  return undefined;
}

/** Why `name` cannot be the name of a new file, or undefined. */
export function fileNameProblem(name: string): string | undefined {
  if (!name) return "ファイルの名前を入れてください。";
  if (name !== name.trim()) return "ファイルの名前の前後に空白は使えません。";
  if (name === "." || name === ".." || name.includes("/")) return "この名前は使えません。";
  if (/\p{Cc}/u.test(name)) return "ファイルの名前に改行や制御文字は使えません。";
  if (Buffer.byteLength(name) > MAX_NAME_BYTES) return "ファイルの名前が長すぎます。";
  return undefined;
}

/** Whether `p` is `root` or inside it (both real paths). */
function isInside(p: string, root: string): boolean {
  const rel = path.relative(root, p);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

const codeOf = (e: unknown): unknown => (e as NodeJS.ErrnoException | undefined)?.code;

/** Why `rel` could not be reached, in words. */
function accessError(e: unknown, rel: string): string {
  const code = codeOf(e);
  if (code === "ENOENT" || code === "ENOTDIR") return `見つかりません：${rel || "."}`;
  if (code === "EACCES" || code === "EPERM") return `読む権限がありません：${rel || "."}`;
  if (code === "ELOOP") return `リンクがループしています：${rel}`;
  return `読めませんでした：${e instanceof Error ? e.message : String(e)}`;
}

/** Why a file could not be written, in words. */
function writeError(e: unknown, rel: string): string {
  const code = codeOf(e);
  if (code === "EACCES" || code === "EPERM") return `書き込む権限がありません：${rel}`;
  if (code === "EROFS") return `読み取り専用のファイルシステムです：${rel}`;
  if (code === "ENOSPC" || code === "EDQUOT") return "ディスクの空きが足りません。";
  if (code === "EISDIR") return `フォルダーです：${rel}`;
  return `保存できませんでした：${e instanceof Error ? e.message : String(e)}`;
}

/**
 * Where `rel` really is inside the session's folder `root`, with symbolic links followed (`real`), and the session's
 * folder itself (`base`). Something that is not there, or that is outside the folder, is an error.
 */
async function locate(root: string, rel: string): Promise<{ real: string; base: string } | Failed> {
  const problem = relPathProblem(rel);
  if (problem) return { error: problem };
  let base: string;
  try {
    base = await fs.realpath(root);
  } catch {
    return { error: `セッションのフォルダーがありません：${root}` };
  }
  let real: string;
  try {
    real = await fs.realpath(path.join(base, ...rel.split("/")));
  } catch (e) {
    return { error: accessError(e, rel) };
  }
  if (!isInside(real, base)) return { error: "セッションのフォルダーの外を指すリンクは開けません。" };
  return { real, base };
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The first `max` bytes of a file (all of it, when it is smaller). */
async function readUpTo(file: string, max: number): Promise<Buffer> {
  const fh = await fs.open(file, "r");
  try {
    const buf = Buffer.allocUnsafe(max);
    let n = 0;
    while (n < max) {
      const { bytesRead } = await fh.read(buf, n, max - n, n);
      if (bytesRead === 0) break;
      n += bytesRead;
    }
    return buf.subarray(0, n);
  } finally {
    await fh.close();
  }
}

/** The text of a UTF-8 file, its byte order mark kept; undefined for a binary file or one in another encoding. */
export function decodeText(bytes: Uint8Array): string | undefined {
  if (bytes.subarray(0, SNIFF_BYTES).includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** Folders first, then by name (numbers in names by their value: "2" before "10"). */
function byKindThenName(a: { name: string; dir: boolean }, b: { name: string; dir: boolean }): number {
  return Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, "en", { numeric: true }) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/** An entry of a folder: what it is, or for a link, what it points to (and whether that is outside `base`). */
async function describe(dir: string, d: Dirent, base: string): Promise<DirEntry> {
  const full = path.join(dir, d.name);
  if (d.isSymbolicLink()) {
    try {
      const real = await fs.realpath(full);
      const st = await fs.stat(real);
      const kind = st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
      // What is outside the folder is not looked into: only whether it is a folder or a file.
      if (!isInside(real, base)) return { name: d.name, kind, link: true, outside: true };
      return { name: d.name, kind, link: true, ...(kind === "file" ? { size: st.size, mtime: Math.round(st.mtimeMs) } : {}) };
    } catch {
      // A broken link, or one that loops.
      return { name: d.name, kind: "other", link: true };
    }
  }
  if (d.isDirectory()) return { name: d.name, kind: "dir" };
  if (d.isFile()) {
    const st = await fs.stat(full).catch(() => undefined);
    return { name: d.name, kind: "file", ...(st ? { size: st.size, mtime: Math.round(st.mtimeMs) } : {}) };
  }
  return { name: d.name, kind: "other" };
}

/** The entries of the folder `rel` inside the session's folder `root` (see DirListing). */
export async function listDir(root: string, rel: string): Promise<DirListing | Failed> {
  const where = await locate(root, rel);
  if ("error" in where) return where;
  let dirents: Dirent[];
  try {
    dirents = await fs.readdir(where.real, { withFileTypes: true });
  } catch (e) {
    return { error: codeOf(e) === "ENOTDIR" ? `フォルダーではありません：${rel}` : accessError(e, rel) };
  }
  // A huge folder is cut before anything in it is looked at; a link sorts as a file until it is.
  const shown = dirents
    .filter((d) => !HIDDEN.has(d.name))
    .map((d) => ({ d, name: d.name, dir: d.isDirectory() }))
    .sort(byKindThenName);
  const entries = await Promise.all(shown.slice(0, MAX_ENTRIES).map(({ d }) => describe(where.real, d, where.base)));
  entries.sort((a, b) => byKindThenName({ name: a.name, dir: a.kind === "dir" }, { name: b.name, dir: b.kind === "dir" }));
  return { path: rel, entries, truncated: shown.length > MAX_ENTRIES };
}

/** The file `rel` inside the session's folder `root` (see FileContent). */
export async function readFileAt(root: string, rel: string): Promise<FileContent | Failed> {
  if (rel === "") return { error: "ファイルを指定してください。" };
  const where = await locate(root, rel);
  if ("error" in where) return where;
  let st: Stats;
  try {
    st = await fs.stat(where.real);
  } catch (e) {
    return { error: accessError(e, rel) };
  }
  if (st.isDirectory()) return { error: `フォルダーです：${rel}` };
  // A FIFO or a device would block, or never end.
  if (!st.isFile()) return { error: `ふつうのファイルではないので、開けません：${rel}` };
  const writable = await fs.access(where.real, constants.W_OK).then(
    () => true,
    () => false,
  );
  const mime = IMAGE_TYPES[path.extname(rel).toLowerCase()];
  const limit = mime ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES;
  const known = { path: rel, size: st.size, mtime: Math.round(st.mtimeMs), writable };
  if (st.size > limit) return { ...known, tooLarge: true };
  let bytes: Buffer;
  try {
    // One byte more than allowed tells a file that grew meanwhile.
    bytes = await readUpTo(where.real, limit + 1);
  } catch (e) {
    return { error: accessError(e, rel) };
  }
  if (bytes.length > limit) return { ...known, size: bytes.length, tooLarge: true };
  const read = { ...known, size: bytes.length, hash: sha256(bytes) };
  if (mime) return { ...read, image: { mime, data: bytes.toString("base64") } };
  const text = decodeText(bytes);
  return text === undefined ? { ...read, binary: true } : { ...read, text };
}

/**
 * Writes `content` as UTF-8 to the file `rel` inside the session's folder `root`. With `baseHash`, only while the file
 * still holds what had that hash: otherwise it changed since it was read (Claude may have edited it), nothing is
 * written, and `conflict` says so. With `create`, makes a new file in a folder that is there, and never overwrites.
 * An existing file is written in place, so it keeps its permissions (and stays the file its links point to).
 */
export async function writeFileAt(
  root: string,
  rel: string,
  content: string,
  { baseHash, create = false }: { baseHash?: string; create?: boolean } = {},
): Promise<FileStamp | Failed> {
  if (rel === "") return { error: "ファイルを指定してください。" };
  const problem = relPathProblem(rel);
  if (problem) return { error: problem };
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length > MAX_TEXT_BYTES) return { error: `${MAX_TEXT_BYTES / 1024 / 1024}MB より大きいファイルは保存できません。` };
  let target: string;
  if (create) {
    const parts = rel.split("/");
    const name = parts.pop() ?? "";
    const nameWrong = fileNameProblem(name);
    if (nameWrong) return { error: nameWrong };
    const parent = await locate(root, parts.join("/"));
    if ("error" in parent) return parent;
    target = path.join(parent.real, name);
    try {
      // O_EXCL: fails on anything already there, a link included (even a broken one).
      await fs.writeFile(target, bytes, { flag: "wx" });
    } catch (e) {
      const code = codeOf(e);
      if (code === "EEXIST") return { error: `同じ名前のファイルかフォルダーが、すでにあります：${rel}` };
      if (code === "ENOTDIR") return { error: `フォルダーではありません：${parts.join("/")}` };
      return { error: writeError(e, rel) };
    }
  } else {
    const where = await locate(root, rel);
    if ("error" in where) return where;
    target = where.real;
    const st = await fs.stat(target).catch(() => undefined);
    if (!st) return { error: `見つかりません：${rel}` };
    if (st.isDirectory()) return { error: `フォルダーです：${rel}` };
    if (!st.isFile()) return { error: `ふつうのファイルではないので、保存できません：${rel}` };
    if (baseHash !== undefined) {
      let now: Buffer;
      try {
        now = await readUpTo(target, MAX_TEXT_BYTES + 1);
      } catch (e) {
        return { error: accessError(e, rel) };
      }
      if (sha256(now) !== baseHash) return { error: "このファイルは、開いたあとで変更されています。", conflict: true };
    }
    try {
      await fs.writeFile(target, bytes);
    } catch (e) {
      return { error: writeError(e, rel) };
    }
  }
  const st = await fs.stat(target).catch(() => undefined);
  return { hash: sha256(bytes), size: bytes.length, mtime: Math.round(st?.mtimeMs ?? Date.now()) };
}
