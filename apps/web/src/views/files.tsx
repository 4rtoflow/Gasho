// The files of a session's folder, as a panel of the session (see SidePanel): the entries of a folder in it, and a
// file's text (Markdown and SVG also as what they show, images as pictures), which can be edited and saved; and new
// files. gasho-daemon reads and writes them on the working server, inside the session's folder only.
import { ChevronRight, Code, Eye, FileImage, FilePlus, FileQuestionMark, FileSymlink, FileText, Folder, FolderOpen, FolderSymlink, Pencil, RefreshCw, WrapText } from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { DirEntry, FileContent } from "@gasho/protocol";
import { BUTTON_PRIMARY, BUTTON_SECONDARY } from "@/components/dialog-styles";
import { MarkdownText } from "@/components/markdown";
import { PANEL_BUTTON, SidePanel } from "@/components/side-panel";
import { getFileDraft, isDirty, setFileDraft, useFileDraft, useFileDrafts } from "@/lib/file-drafts";
import {
  baseName,
  formatBytes,
  fromEditable,
  isMarkdown,
  isSvg,
  joinPath,
  lineCount,
  newFileNameProblem,
  parentPath,
  pathSteps,
  toEditable,
} from "@/lib/file-text";
import { useFlag } from "@/lib/flag";
import { basename, relativeTime } from "@/lib/format";
import { isDesktop } from "@/lib/media";
import { go, hrefOf, type Route } from "@/lib/route";
import { fileKey, loadDir, loadFile, saveFile, useAppState } from "@/lib/store";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";

/** Beyond this many lines, a text is shown without line numbers (one element per line would be slow). */
const MAX_NUMBERED_LINES = 5000;
const IMAGE_NAME = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;

const folderRoute = (machine: string, sessionId: string, path: string): Route => ({
  name: "session",
  machine,
  sessionId,
  panel: path ? { kind: "files", path } : { kind: "files" },
});

const fileRoute = (machine: string, sessionId: string, path: string): Route => ({ name: "session", machine, sessionId, panel: { kind: "file", path } });

const clock = (ms: number): string => new Date(ms).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });

interface PanelProps {
  machine: string;
  sessionId: string;
  /** From the session's folder: the folder shown ("" for the folder itself), or the file. */
  path: string;
  docked: boolean;
  onClose: () => void;
}

function Missing({ title, machineName, docked, onClose }: { title: string; machineName?: string; docked: boolean; onClose: () => void }) {
  return (
    <SidePanel title={title} docked={docked} onClose={onClose}>
      <p className="text-sm text-muted-foreground">このセッションは見つかりません。終了したか、{machineName ?? "この working server"} の gasho-daemon が接続していません。</p>
    </SidePanel>
  );
}

/** A folder inside the session's folder: its folders and files, each opened by a link. */
export function FolderPanel({ machine, sessionId, path, docked, onClose }: PanelProps) {
  const { machines, dirs } = useAppState();
  const drafts = useFileDrafts();
  const now = useNow(60_000);
  const [creating, setCreating] = useState(false);
  const m = machines.find((x) => x.id === machine);
  const s = m?.sessions.find((x) => x.sessionId === sessionId);
  const d = dirs[fileKey(machine, sessionId, path)];
  const dir = d?.dir;

  useEffect(() => {
    if (m?.connected) loadDir(machine, sessionId, path);
  }, [machine, sessionId, path, m?.connected]);

  if (!m || !s) return <Missing title="ファイル" machineName={m?.name} docked={docked} onClose={onClose} />;

  return (
    <SidePanel
      title="ファイル"
      subtitle={`${m.name} · ${s.cwd}`}
      docked={docked}
      onClose={onClose}
      actions={
        <>
          <button
            type="button"
            onClick={() => setCreating(true)}
            disabled={!m.connected || creating}
            title="このフォルダーに新しいファイルを作る"
            className={PANEL_BUTTON}
          >
            <FilePlus className="size-3.5" />
            新しいファイル
          </button>
          <button
            type="button"
            onClick={() => loadDir(machine, sessionId, path)}
            disabled={d?.loading || !m.connected}
            aria-label="再読み込み"
            title="再読み込み"
            className={PANEL_BUTTON}
          >
            <RefreshCw className={cn("size-3.5", d?.loading && "animate-spin")} />
          </button>
        </>
      }
    >
      <Breadcrumbs root={basename(s.cwd)} path={path} routeOf={(p) => folderRoute(machine, sessionId, p)} />
      {creating && <NewFileForm machine={machine} sessionId={sessionId} dir={path} onCancel={() => setCreating(false)} />}
      <div className="space-y-3">
        {!m.connected && <p className="text-sm text-muted-foreground">{m.name} はオフラインです。</p>}
        {d?.error && <p className="text-sm text-red-400">{d.error}</p>}
        {!dir && d?.loading && <p className="text-sm text-muted-foreground">読み込み中…</p>}
        {dir &&
          (dir.entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">このフォルダーは空です。</p>
          ) : (
            <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
              {dir.entries.map((e) => {
                const p = joinPath(path, e.name);
                return (
                  <EntryRow
                    key={e.name}
                    entry={e}
                    now={now}
                    unsaved={isDirty(drafts.get(fileKey(machine, sessionId, p)))}
                    href={hrefOf(e.kind === "dir" ? folderRoute(machine, sessionId, p) : fileRoute(machine, sessionId, p))}
                  />
                );
              })}
            </ul>
          ))}
        {dir?.truncated && <p className="text-xs text-muted-foreground">名前の順に、最初の {dir.entries.length} 件を表示しています。</p>}
        {d?.at && <p className="text-xs text-muted-foreground">{clock(d.at)} に読み込み</p>}
      </div>
    </SidePanel>
  );
}

function EntryRow({ entry: e, href, now, unsaved }: { entry: DirEntry; href: string; now: number; unsaved: boolean }) {
  const Icon =
    e.kind === "dir" ? (e.link ? FolderSymlink : Folder) : e.kind === "file" ? (e.link ? FileSymlink : IMAGE_NAME.test(e.name) ? FileImage : FileText) : FileQuestionMark;
  // What cannot be opened says why.
  const why = e.outside ? "フォルダーの外" : e.kind === "other" ? (e.link ? "リンク切れ" : "開けません") : undefined;
  const body = (
    <>
      <Icon aria-hidden className={cn("size-4 shrink-0", e.kind === "dir" ? "text-sky-400" : "text-muted-foreground")} />
      <span className="min-w-0 flex-1 truncate text-sm">{e.name}</span>
      {unsaved && <span className="shrink-0 text-xs text-amber-400">未保存</span>}
      {why ? (
        <span className="shrink-0 text-xs text-muted-foreground">{why}</span>
      ) : (
        e.kind === "file" &&
        e.size !== undefined && (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {formatBytes(e.size)}
            {e.mtime !== undefined && <span className="hidden @xs:inline"> · {relativeTime(e.mtime, now)}</span>}
          </span>
        )
      )}
    </>
  );
  return (
    <li>
      {why ? (
        <div
          className="flex items-center gap-2.5 px-3 py-2 opacity-60"
          title={e.outside ? "セッションのフォルダーの外を指すリンクは開けません。" : undefined}
        >
          {body}
        </div>
      ) : (
        <a href={href} className="flex items-center gap-2.5 px-3 py-2 hover:bg-surface-raised">
          {body}
        </a>
      )}
    </li>
  );
}

/** Where the folder (and the file, `file`) is: the session's folder, then each folder on the way, each a link. */
function Breadcrumbs({ root, path, file, routeOf }: { root: string; path: string; file?: string; routeOf: (path: string) => Route }) {
  const steps = pathSteps(path);
  const link = "rounded px-1 py-0.5 break-all hover:bg-surface-raised hover:text-foreground";
  const here = "px-1 py-0.5 font-medium break-all text-foreground";
  const sep = <ChevronRight aria-hidden className="size-3.5 shrink-0" />;
  return (
    <nav aria-label="場所" className="-mx-1 mb-3 flex flex-wrap items-center gap-y-0.5 text-sm text-muted-foreground">
      {steps.length === 0 && !file ? (
        <span aria-current="page" className={cn("inline-flex items-center gap-1.5", here)}>
          <FolderOpen aria-hidden className="size-3.5 shrink-0" />
          {root}
        </span>
      ) : (
        <a href={hrefOf(routeOf(""))} className={cn("inline-flex items-center gap-1.5", link)}>
          <FolderOpen aria-hidden className="size-3.5 shrink-0" />
          {root}
        </a>
      )}
      {steps.map(([name, p], i) => (
        <Fragment key={p}>
          {sep}
          {i === steps.length - 1 && !file ? (
            <span aria-current="page" className={here}>
              {name}
            </span>
          ) : (
            <a href={hrefOf(routeOf(p))} className={link}>
              {name}
            </a>
          )}
        </Fragment>
      ))}
      {file && (
        <>
          {sep}
          <span aria-current="page" className={here}>
            {file}
          </span>
        </>
      )}
    </nav>
  );
}

/** Makes an empty file in the folder shown, and opens it in the editor (as an editor's "new file" does). */
function NewFileForm({ machine, sessionId, dir, onCancel }: { machine: string; sessionId: string; dir: string; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const problem = newFileNameProblem(name);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(undefined);
    const path = joinPath(dir, name);
    const r = await saveFile(machine, sessionId, path, "", { create: true });
    setBusy(false);
    if (!r.ok) {
      setError(r.error ?? "作れませんでした。");
      return;
    }
    setFileDraft(fileKey(machine, sessionId, path), { value: "", original: "", baseHash: r.written?.hash, eol: "\n", bom: false });
    go(fileRoute(machine, sessionId, path));
  };

  return (
    <form
      onSubmit={submit}
      onKeyDown={(e) => {
        // Esc closes the form, not the panel; while an input method converts, it only cancels the conversion.
        if (e.key !== "Escape") return;
        e.stopPropagation();
        if (!busy && !e.nativeEvent.isComposing) onCancel();
      }}
      className="mb-3 space-y-2.5 rounded-xl border border-border p-3"
    >
      <label className="block space-y-1.5">
        <span className="text-xs text-muted-foreground">新しいファイルの名前（このフォルダーに作ります）</span>
        <input
          // Opened from its button, to type at once.
          autoFocus
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError(undefined);
          }}
          placeholder="memo.md"
          disabled={busy}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          // 16px on phones stops iOS zooming into the field.
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-[16px] outline-none focus:border-border-hover disabled:opacity-60 sm:text-sm"
        />
      </label>
      {error && <p className="text-sm text-red-400">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} disabled={busy} className={BUTTON_SECONDARY}>
          キャンセル
        </button>
        <button type="submit" disabled={busy || !name.trim()} className={BUTTON_PRIMARY}>
          {busy ? "作っています…" : "作る"}
        </button>
      </div>
    </form>
  );
}

/**
 * A file inside the session's folder: its text with line numbers (Markdown and SVG also as what they show), an image,
 * or why it is not shown. A text file opens in the editor with "編集": the text is kept while Gasho is open (see
 * lib/file-drafts.ts) and saved over the version that was read only, so that what Claude wrote meanwhile is not lost.
 */
export function FilePanel({ machine, sessionId, path, docked, onClose }: PanelProps) {
  const { machines, files } = useAppState();
  const now = useNow(60_000);
  const m = machines.find((x) => x.id === machine);
  const s = m?.sessions.find((x) => x.sessionId === sessionId);
  const key = fileKey(machine, sessionId, path);
  const f = files[key];
  const file = f?.file;
  const text = file?.text;
  const draft = useFileDraft(key);
  const dirty = isDirty(draft);
  // Phones wrap long lines unless told otherwise; computers scroll them.
  const [wrap, setWrap] = useFlag("gasho.files.wrap", !isDesktop());
  // Markdown and SVG: their text rather than what they show.
  const [source, setSource] = useFlag("gasho.files.source", false);
  const [saving, setSaving] = useState(false);
  const savingNow = useRef(false);
  const [error, setError] = useState<string>();
  // The last save was refused: the file had changed since it was read.
  const [conflict, setConflict] = useState(false);
  const [savedAt, setSavedAt] = useState<number>();
  const eol = useMemo(() => (text === undefined ? undefined : toEditable(text).eol), [text]);

  useEffect(() => {
    if (m?.connected) loadFile(machine, sessionId, path);
  }, [machine, sessionId, path, m?.connected]);
  // Left without changes, the editor closes: coming back shows the file. Changes not saved stay for later.
  useEffect(
    () => () => {
      if (!isDirty(getFileDraft(key))) setFileDraft(key, undefined);
    },
    [key],
  );

  const name = baseName(path);
  if (!m || !s) return <Missing title={name} machineName={m?.name} docked={docked} onClose={onClose} />;

  const shows = isMarkdown(path) ? "markdown" : isSvg(path) ? "svg" : undefined;
  // Read again since editing started, and it is not what editing started from.
  const stale = draft !== undefined && file?.hash !== undefined && draft.baseHash !== undefined && file.hash !== draft.baseHash;

  const reset = () => {
    setError(undefined);
    setConflict(false);
    setSavedAt(undefined);
  };

  const edit = () => {
    if (text === undefined) return;
    const e = toEditable(text);
    setFileDraft(key, { value: e.value, original: e.value, baseHash: file?.hash, eol: e.eol, bom: e.bom });
    reset();
  };

  /** Saves over the version editing started from, or with `overwrite`, whatever the file holds now. */
  const save = async (overwrite = false) => {
    const d = getFileDraft(key);
    if (!d || savingNow.current) return;
    savingNow.current = true;
    setSaving(true);
    setError(undefined);
    const r = await saveFile(machine, sessionId, path, fromEditable(d.value, d), overwrite ? {} : { baseHash: d.baseHash });
    if (r.ok) {
      // What was typed while it was being saved is still to be saved.
      const later = getFileDraft(key);
      if (later) setFileDraft(key, { ...later, original: d.value, baseHash: r.written?.hash });
      setConflict(false);
      setSavedAt(Date.now());
    } else {
      setConflict(r.conflict === true);
      setError(r.conflict ? undefined : (r.error ?? "保存できませんでした。"));
    }
    savingNow.current = false;
    setSaving(false);
  };

  const close = () => {
    if (dirty && !window.confirm("保存していない変更を捨てて、編集をやめますか？")) return;
    setFileDraft(key, undefined);
    reset();
  };

  const discardAndReload = () => {
    if (dirty && !window.confirm("編集した内容を捨てて、いまのファイルを読み込み直しますか？")) return;
    setFileDraft(key, undefined);
    reset();
    loadFile(machine, sessionId, path);
  };

  const actions = draft ? (
    <>
      <button type="button" onClick={close} disabled={saving} className={PANEL_BUTTON}>
        {dirty ? "やめる" : "閉じる"}
      </button>
      <button
        type="button"
        onClick={() => void save()}
        disabled={saving || !dirty || !m.connected}
        title="保存する（Ctrl+S・⌘S）"
        className={cn(PANEL_BUTTON, "border-transparent bg-primary font-medium text-primary-foreground hover:opacity-90")}
      >
        {saving ? "保存中…" : "保存"}
      </button>
    </>
  ) : (
    <>
      {text !== undefined && (
        <button
          type="button"
          onClick={edit}
          disabled={!m.connected || !file?.writable}
          title={file?.writable ? "このファイルを編集する" : "このファイルには書き込めません（読み取り専用）"}
          className={PANEL_BUTTON}
        >
          <Pencil className="size-3.5" />
          編集
        </button>
      )}
      <button
        type="button"
        onClick={() => loadFile(machine, sessionId, path)}
        disabled={f?.loading || !m.connected}
        aria-label="再読み込み"
        title="再読み込み"
        className={PANEL_BUTTON}
      >
        <RefreshCw className={cn("size-3.5", f?.loading && "animate-spin")} />
      </button>
    </>
  );

  return (
    <SidePanel title={name} subtitle={`${m.name} · ${s.cwd}`} docked={docked} onClose={onClose} actions={actions}>
      <div
        onKeyDown={(e: KeyboardEvent) => {
          if (draft && (e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "s") {
            e.preventDefault();
            void save();
          }
        }}
      >
        <Breadcrumbs root={basename(s.cwd)} path={parentPath(path)} file={name} routeOf={(p) => folderRoute(machine, sessionId, p)} />
        {file && (
          <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted-foreground">
            <span className="tabular-nums">{formatBytes(file.size)}</span>
            <span title={new Date(file.mtime).toLocaleString("ja-JP")}>更新 {relativeTime(file.mtime, now)}</span>
            {text !== undefined && <span className="tabular-nums">{lineCount(text)} 行</span>}
            {eol === "\r\n" && <span title="改行が CRLF のファイルです。保存するときも CRLF にします。">CRLF</span>}
            {!file.writable && <span className="text-amber-400">読み取り専用</span>}
            {dirty && <span className="text-amber-400">未保存の変更があります</span>}
            {text !== undefined && (
              <span className="ml-auto flex items-center gap-1.5">
                {shows && !draft && <ViewToggle source={source} onChange={setSource} />}
                <button
                  type="button"
                  aria-pressed={wrap}
                  onClick={() => setWrap(!wrap)}
                  title="長い行を折り返す"
                  className={cn(PANEL_BUTTON, wrap && "border-border-hover bg-surface-raised text-foreground")}
                >
                  <WrapText className="size-3.5" />
                  折り返す
                </button>
              </span>
            )}
          </div>
        )}
        <div className="space-y-3">
          {!m.connected && <p className="text-sm text-muted-foreground">{m.name} はオフラインです。</p>}
          {f?.error && <p className="text-sm text-red-400">{f.error}</p>}
          {!file && !draft && f?.loading && <p className="text-sm text-muted-foreground">読み込み中…</p>}
          {draft && (conflict || stale) && (
            <ConflictNotice refused={conflict} saving={saving} onOverwrite={() => void save(true)} onReload={discardAndReload} />
          )}
          {draft && error && <p className="text-sm text-red-400">{error}</p>}
          {draft && savedAt !== undefined && !dirty && !error && <p className="text-xs text-emerald-400">保存しました（{clock(savedAt)}）</p>}
          {draft ? (
            <Editor
              value={draft.value}
              wrap={wrap}
              onChange={(value) => {
                const d = getFileDraft(key);
                if (d) setFileDraft(key, { ...d, value });
              }}
            />
          ) : (
            file && <FileView file={file} name={name} wrap={wrap} source={source} shows={shows} />
          )}
        </div>
      </div>
    </SidePanel>
  );
}

function ConflictNotice({ refused, saving, onOverwrite, onReload }: { refused: boolean; saving: boolean; onOverwrite: () => void; onReload: () => void }) {
  return (
    <div role="alert" className="space-y-2.5 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-200">
      <p>
        {refused
          ? "保存しませんでした。このファイルは、編集を始めたあとで変更されています（Claude が書き換えたのかもしれません）。"
          : "このファイルは、編集を始めたあとで変更されています（Claude が書き換えたのかもしれません）。"}
        上書きして保存すると、その変更は消えます。
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={onOverwrite} disabled={saving} className={PANEL_BUTTON}>
          上書きして保存
        </button>
        <button type="button" onClick={onReload} disabled={saving} className={PANEL_BUTTON}>
          編集を捨てて読み込み直す
        </button>
      </div>
    </div>
  );
}

/** Markdown and SVG: what they show, or their text. */
function ViewToggle({ source, onChange }: { source: boolean; onChange: (source: boolean) => void }) {
  const item = (on: boolean) => cn("inline-flex items-center gap-1 px-2 py-1", on ? "bg-surface-raised text-foreground" : "hover:text-foreground");
  return (
    <div role="group" aria-label="表示のしかた" className="inline-flex overflow-hidden rounded-lg border border-border">
      <button type="button" aria-pressed={!source} onClick={() => onChange(false)} className={item(!source)}>
        <Eye className="size-3.5" />
        表示
      </button>
      <button type="button" aria-pressed={source} onClick={() => onChange(true)} className={cn(item(source), "border-l border-border")}>
        <Code className="size-3.5" />
        テキスト
      </button>
    </div>
  );
}

function FileView({ file, name, wrap, source, shows }: { file: FileContent; name: string; wrap: boolean; source: boolean; shows?: "markdown" | "svg" }) {
  if (file.tooLarge) {
    return (
      <p className="text-sm text-muted-foreground">
        大きすぎるので表示しません（{formatBytes(file.size)}）。表示できるのは、テキストは 1MB、画像は 5MB までです。
      </p>
    );
  }
  if (file.image) {
    return (
      <div className="overflow-hidden rounded-xl border border-border bg-[image:repeating-conic-gradient(#ffffff0d_0%_25%,transparent_0%_50%)] bg-[length:16px_16px] p-3">
        <img alt={name} src={`data:${file.image.mime};base64,${file.image.data}`} className="mx-auto max-h-[70vh] max-w-full" />
      </div>
    );
  }
  if (file.text === undefined) {
    return <p className="text-sm text-muted-foreground">テキストのファイルではない（バイナリか、UTF-8 以外の文字コードの）ので、表示しません。</p>;
  }
  if (shows === "markdown" && !source) {
    return (
      <div className="rounded-xl border border-border px-4 py-3">
        {file.text.trim() ? <MarkdownText text={file.text.replace(/^﻿/, "")} /> : <p className="text-sm text-muted-foreground">空のファイルです。</p>}
      </div>
    );
  }
  if (shows === "svg" && !source) {
    // As an image, an SVG runs no script and loads nothing.
    return (
      <div className="overflow-hidden rounded-xl border border-border bg-[image:repeating-conic-gradient(#ffffff0d_0%_25%,transparent_0%_50%)] bg-[length:16px_16px] p-3">
        <img alt={name} src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(file.text)}`} className="mx-auto max-h-[70vh] max-w-full" />
      </div>
    );
  }
  return <TextView text={file.text} wrap={wrap} />;
}

const CODE = "font-mono text-[12.5px] leading-[1.6] [tab-size:4]";

/** A text with line numbers, which stay in place while long lines scroll sideways. */
function TextView({ text, wrap }: { text: string; wrap: boolean }) {
  const lines = useMemo(() => {
    const all = text.split(/\r\n|\r|\n/);
    if (all.length > 1 && all.at(-1) === "") all.pop();
    return all;
  }, [text]);
  if (text === "") return <p className="text-sm text-muted-foreground">空のファイルです。</p>;
  // Its scrollbar in the dark colours of the screen.
  const box = "overflow-x-auto rounded-xl border border-border bg-surface py-2 dark:[color-scheme:dark]";
  if (lines.length > MAX_NUMBERED_LINES) {
    return <pre className={cn(box, CODE, "px-3", wrap ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "whitespace-pre")}>{text}</pre>;
  }
  const digits = String(lines.length).length;
  return (
    <div className={cn(box, CODE)}>
      <div className={wrap ? undefined : "w-max min-w-full"}>
        {lines.map((line, i) => (
          <div key={i} className="flex">
            <span
              aria-hidden
              className="sticky left-0 shrink-0 bg-surface pr-3 pl-3 text-right text-muted-foreground/50 select-none"
              style={{ width: `calc(${digits}ch + 1.5rem)` }}
            >
              {i + 1}
            </span>
            {/* An empty line keeps its height. */}
            <span className={cn("min-w-0 pr-4", wrap ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "whitespace-pre")}>{line || " "}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The text box of the editor. It grows with its text, so that the panel scrolls rather than the box. */
function Editor({ value, wrap, onChange }: { value: string; wrap: boolean; onChange: (value: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [width, setWidth] = useState(0);
  const measured = useRef({ length: -1, wrap, width });
  useLayoutEffect(() => {
    const t = ref.current;
    if (!t) return;
    // Measured from scratch only when it may have to shrink: laying out a long text twice at each key is slow.
    const was = measured.current;
    if (value.length < was.length || wrap !== was.wrap || width !== was.width) t.style.height = "auto";
    measured.current = { length: value.length, wrap, width };
    // Its borders, and a scrollbar for long lines that are not wrapped, take room besides the text.
    const height = t.scrollHeight + t.offsetHeight - t.clientHeight;
    if (t.style.height === "auto" || height > t.offsetHeight) t.style.height = `${height}px`;
  }, [value, wrap, width]);
  // Wrapped lines take more or less room when the panel's width changes.
  useEffect(() => {
    const t = ref.current;
    if (!t) return;
    const o = new ResizeObserver(([e]) => setWidth(Math.round(e?.contentRect.width ?? 0)));
    o.observe(t);
    return () => o.disconnect();
  }, []);
  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        // Esc belongs to the text box (an input method uses it to cancel a conversion), not to the panel it would close.
        if (e.key === "Escape") e.stopPropagation();
      }}
      wrap={wrap ? "soft" : "off"}
      aria-label="ファイルの内容"
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      autoComplete="off"
      // 16px on phones stops iOS zooming into the box.
      className={cn(
        "block w-full resize-none overflow-y-hidden rounded-xl border border-border bg-surface px-3 py-2 font-mono text-[16px] leading-[1.6] outline-none [tab-size:4] focus:border-border-hover sm:text-[12.5px] dark:[color-scheme:dark]",
        wrap ? "overflow-x-hidden" : "overflow-x-auto whitespace-pre",
      )}
    />
  );
}
