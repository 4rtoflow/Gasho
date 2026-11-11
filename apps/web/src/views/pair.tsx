import { KeyRound } from "lucide-react";
import { useState } from "react";
import { errorText, guessDeviceName, pairBrowser } from "@/lib/api";
import { start } from "@/lib/store";

/** Shown to browsers that are not registered yet. */
export function PairView() {
  const [code, setCode] = useState("");
  const [name, setName] = useState(guessDeviceName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await pairBrowser(code, name.trim());
      await start();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-4 text-foreground">
      <form onSubmit={submit} className="w-full max-w-sm space-y-5 rounded-2xl border border-border bg-surface/60 p-6">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-lg font-semibold">
            <KeyRound className="size-5" />
            このブラウザを登録する
          </div>
          <p className="text-sm text-muted-foreground">Gasho を使うには、登録コードでこのブラウザを登録します。</p>
        </div>
        <label className="block space-y-1.5">
          <span className="text-xs text-muted-foreground">登録コード</span>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="ABCD-2345"
            autoComplete="one-time-code"
            autoCapitalize="characters"
            spellCheck={false}
            required
            className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-lg tracking-widest outline-none focus:border-border-hover"
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-xs text-muted-foreground">この端末の名前</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            required
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-border-hover"
          />
        </label>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={busy || !code.trim() || !name.trim()}
          className="w-full rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {busy ? "登録しています…" : "登録する"}
        </button>
        <div className="space-y-1 text-xs leading-relaxed text-muted-foreground">
          <p>登録コードは、次のどちらかで発行します。コードは10分間有効で、1回だけ使えます。</p>
          <ul className="list-disc space-y-1 pl-4">
            <li>
              Gasho サーバーで <code className="font-mono text-foreground/80">npm run hub:pair</code> を実行する
            </li>
            <li>登録済みの端末で、Gasho の「端末」画面を開く</li>
          </ul>
        </div>
      </form>
    </div>
  );
}
