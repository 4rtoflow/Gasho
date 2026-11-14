// The files of a session's folder as the files panel shows and edits them. A browser's text box keeps "\n" alone for
// a line break, so a file's line endings (and its byte order mark) are taken off for editing and put back for saving.
// Paths are from the session's folder, "/"-separated, as gasho-daemon takes them.

/** How lines end in a file. */
export type Eol = "\n" | "\r\n";

/** A file's text as the text box holds it, and what to put back when it is saved. */
export interface EditableText {
  /** Lines end with "\n"; no byte order mark. */
  value: string;
  eol: Eol;
  bom: boolean;
}

/**
 * The text of a file for editing. A file whose lines mostly end with "\r\n" is saved with "\r\n" again; a file that
 * mixes the two gets the one most of its lines have (lines that ended with the other one change).
 */
export function toEditable(text: string): EditableText {
  const bom = text.startsWith("﻿");
  const body = bom ? text.slice(1) : text;
  const crlf = body.match(/\r\n/g)?.length ?? 0;
  const lf = (body.match(/\n/g)?.length ?? 0) - crlf;
  return { value: body.replace(/\r\n?/g, "\n"), eol: crlf > lf ? "\r\n" : "\n", bom };
}

/** What is saved: the text box's text with the file's line endings and byte order mark. */
export function fromEditable(value: string, { eol, bom }: { eol: Eol; bom: boolean }): string {
  const lines = value.replace(/\r\n?/g, "\n");
  const body = eol === "\r\n" ? lines.replace(/\n/g, "\r\n") : lines;
  return bom ? `﻿${body}` : body;
}

/** The path of `name` in the folder `dir` ("" is the session's folder). */
export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/** The folder something is in ("" for the session's folder). */
export function parentPath(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** The last name of a path. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** The folders on the way to `path`, from the session's folder: [name, its path] for each. */
export function pathSteps(path: string): [string, string][] {
  if (!path) return [];
  const names = path.split("/");
  return names.map((name, i) => [name, names.slice(0, i + 1).join("/")]);
}

/**
 * A size in bytes, in words: "820 B", "12.4 KB", "3.1 MB". Under 10, one decimal, rounded up: a file just over a
 * limit of 1 MB reads "1.1 MB", not "1.0 MB".
 */
export function formatBytes(n: number): string {
  const shown = (x: number): string => (x < 10 ? (Math.ceil(x * 10 - 1e-9) / 10).toFixed(1) : String(Math.round(x)));
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${shown(kb)} KB`;
  return `${shown(kb / 1024)} MB`;
}

/** Files shown as Markdown, or as a picture (SVG), besides their text. */
export const isMarkdown = (path: string): boolean => /\.(md|markdown|mdx)$/i.test(path);
export const isSvg = (path: string): boolean => /\.svg$/i.test(path);

/** Why `name` cannot be the name of a new file in the folder shown, or undefined (gasho-daemon checks it again). */
export function newFileNameProblem(name: string): string | undefined {
  if (!name.trim()) return "ファイルの名前を入れてください。";
  if (name !== name.trim()) return "ファイルの名前の前後に空白は使えません。";
  if (name === "." || name === "..") return "この名前は使えません。";
  if (name.includes("/")) return "名前に / は使えません。ほかのフォルダーに作るときは、そのフォルダーを開いてから作ってください。";
  if (/\p{Cc}/u.test(name)) return "ファイルの名前に改行や制御文字は使えません。";
  if (new TextEncoder().encode(name).length > 255) return "ファイルの名前が長すぎます。";
  return undefined;
}

/** How many lines a text has, as an editor counts them (a last line break does not start one more). */
export function lineCount(text: string): number {
  if (text === "") return 0;
  const breaks = text.match(/\n/g)?.length ?? 0;
  return text.endsWith("\n") ? breaks : breaks + 1;
}
