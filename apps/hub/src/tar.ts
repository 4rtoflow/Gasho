// Reads a plugin's release file (<id>-<version>.tgz: the files of its dist/, as a gzip'd tar) without unpacking
// anything that must not be (docs/plugins.md, 安全): an archive with an absolute path, "..", a link, or anything but
// files and folders is refused as a whole, and so is one bigger than the limits. Nothing is written here; the caller
// writes the files it gets back.
import zlib from "node:zlib";

export interface TarFile {
  /** Relative, "/"-separated, without "." or ".." ("web.js", "assets/chunk.js"). */
  path: string;
  data: Buffer;
}

export interface TarLimits {
  /** The files' bytes, in all. */
  maxBytes: number;
  maxFiles: number;
}

const BLOCK = 512;

/** A NUL-terminated string field of a header. */
function field(h: Buffer, start: number, length: number): string {
  const raw = h.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? length : end).toString("utf8");
}

/** An octal number field of a header (sizes over 8 GB, written in base 256, are refused as too big anyway). */
function octal(h: Buffer, start: number, length: number): number {
  if ((h[start] ?? 0) & 0x80) return Number.POSITIVE_INFINITY;
  const text = field(h, start, length).trim();
  if (!/^[0-7]*$/.test(text)) return Number.NaN;
  return text ? parseInt(text, 8) : 0;
}

function checksumOk(h: Buffer): boolean {
  const want = octal(h, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : (h[i] ?? 0);
  return sum === want;
}

/** The records of a pax extended header ("<length> <key>=<value>\n"). */
function paxRecords(data: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    if (space === -1) break;
    const length = Number(data.subarray(i, space).toString("ascii"));
    if (!Number.isInteger(length) || length <= 0 || i + length > data.length) throw new Error("アーカイブが壊れています。");
    const record = data.subarray(space + 1, i + length - 1).toString("utf8");
    const eq = record.indexOf("=");
    if (eq > 0) out.set(record.slice(0, eq), record.slice(eq + 1));
    i += length;
  }
  return out;
}

/**
 * A path of the archive as a relative path ("./web.js" → "web.js"); "" for the archive's top folder itself; undefined
 * for one that must not be unpacked (absolute, with "..", or otherwise odd).
 */
export function entryPath(raw: string): string | undefined {
  let p = raw;
  while (p.startsWith("./")) p = p.slice(2);
  if (p.endsWith("/")) p = p.slice(0, -1);
  if (p === "" || p === ".") return "";
  if (p.startsWith("/") || p.includes("\\") || p.includes("\0") || p.length > 300) return undefined;
  const parts = p.split("/");
  return parts.every((s) => s !== "" && s !== "." && s !== "..") ? p : undefined;
}

/** The files and folders of a .tgz; throws (with the reason, in words for the plugins screen) when it is refused. */
export function readTgz(gz: Buffer, limits: TarLimits): { files: TarFile[]; dirs: string[] } {
  let tar: Buffer;
  try {
    // Headers and padding take at most 1 KB per entry on top of the files.
    tar = zlib.gunzipSync(gz, { maxOutputLength: limits.maxBytes + (limits.maxFiles + 16) * 2 * BLOCK + 64 * 1024 });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new Error(code === "ERR_BUFFER_TOO_LARGE" ? `展開すると大きすぎます（${limits.maxBytes / 1024 / 1024}MB まで）。` : "gzip のファイルとして読めません。");
  }
  const files: TarFile[] = [];
  const dirs: string[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  // A pax header ("x") or a GNU long name ("L") names the entry after it.
  let nextPath: string | undefined;
  let nextSize: number | undefined;
  let offset = 0;
  let ended = false;
  while (offset + BLOCK <= tar.length) {
    const h = tar.subarray(offset, offset + BLOCK);
    if (h.every((b) => b === 0)) {
      ended = true;
      break;
    }
    if (!checksumOk(h)) throw new Error("アーカイブが壊れています（ヘッダーの検査に合いません）。");
    const type = String.fromCharCode(h[156] ?? 0);
    let size = octal(h, 124, 12);
    if (nextSize !== undefined && (type === "0" || type === "\0")) size = nextSize;
    if (!Number.isFinite(size) || size < 0) throw new Error("アーカイブが壊れています（大きさが読めません）。");
    if (size > limits.maxBytes) throw new Error(`展開すると大きすぎます（${limits.maxBytes / 1024 / 1024}MB まで）。`);
    const start = offset + BLOCK;
    const end = start + size;
    if (end > tar.length) throw new Error("アーカイブが途中で切れています。");
    const data = tar.subarray(start, end);
    offset = start + Math.ceil(size / BLOCK) * BLOCK;

    if (type === "x") {
      const records = paxRecords(data);
      nextPath = records.get("path") ?? nextPath;
      const s = records.get("size");
      if (s !== undefined) nextSize = Number(s);
      continue;
    }
    if (type === "g") continue; // pax global header: comments and the like
    if (type === "L") {
      nextPath = data.toString("utf8").replace(/\0+$/, "");
      continue;
    }
    const prefix = field(h, 257, 6).startsWith("ustar") ? field(h, 345, 155) : "";
    const name = nextPath ?? (prefix ? `${prefix}/${field(h, 0, 100)}` : field(h, 0, 100));
    nextPath = undefined;
    nextSize = undefined;
    const rel = entryPath(name);
    if (rel === undefined) throw new Error(`展開できないパスがあります（${name.slice(0, 100)}）。`);
    if (type === "5") {
      if (rel && !seen.has(rel)) {
        seen.add(rel);
        dirs.push(rel);
      }
      continue;
    }
    if (type !== "0" && type !== "\0") {
      const what = type === "1" || type === "2" ? "リンク" : "ふつうのファイルとフォルダーでないもの";
      throw new Error(`アーカイブに${what}があります（${name.slice(0, 100)}）。`);
    }
    if (!rel) throw new Error("アーカイブのファイルの名前が空です。");
    if (seen.has(rel)) throw new Error(`同じパスが2回あります（${rel}）。`);
    seen.add(rel);
    bytes += size;
    if (bytes > limits.maxBytes) throw new Error(`展開すると大きすぎます（${limits.maxBytes / 1024 / 1024}MB まで）。`);
    if (files.length >= limits.maxFiles) throw new Error(`ファイルが多すぎます（${limits.maxFiles}個まで）。`);
    files.push({ path: rel, data: Buffer.from(data) });
  }
  if (!ended && files.length === 0 && dirs.length === 0) throw new Error("tar のファイルとして読めません。");
  // A file cannot also be a folder ("a" and "a/b").
  const filePaths = new Set(files.map((f) => f.path));
  for (const p of [...files.map((f) => f.path), ...dirs]) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join("/");
      if (filePaths.has(parent)) throw new Error(`ファイルとフォルダーが同じ名前です（${parent}）。`);
    }
  }
  for (const d of dirs) if (filePaths.has(d)) throw new Error(`ファイルとフォルダーが同じ名前です（${d}）。`);
  return { files, dirs };
}
