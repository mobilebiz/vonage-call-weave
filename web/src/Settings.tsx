import { useEffect, useRef, useState } from 'react';
import { fetchSettings, HttpError, saveSettings, type SettingsView } from './api';
import { fmtDateTime } from './format';

// クライアント側の簡易チェック。最終的な検証はサーバーが行う
const SIP_URI_RE = /^sips?:[A-Za-z0-9._~%!$&'()*+,=:-]+@[A-Za-z0-9.-]+(:[0-9]{1,5})?(;[A-Za-z0-9._~%=-]+)*$/;

export function SettingsDialog(props: { onClose: () => void }) {
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    dialog.current?.showModal();
    const ctrl = new AbortController();
    fetchSettings(ctrl.signal)
      .then((s) => {
        setSettings(s);
        setValue(s.sipTargetUri);
      })
      .catch((e: Error) => !ctrl.signal.aborted && setError(`設定を取得できません: ${e.message}`));
    return () => ctrl.abort();
  }, []);

  const trimmed = value.trim();
  const invalid = trimmed !== '' && !SIP_URI_RE.test(trimmed);
  const unchanged = settings !== null && trimmed === settings.sipTargetUri;

  const submit = async (uri: string) => {
    if (!settings) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const next = await saveSettings(uri, settings.revision);
      setSettings(next);
      setValue(next.sipTargetUri);
      setSaved(true);
    } catch (e) {
      setError(e instanceof HttpError && e.status === 409 ? `${e.message}` : `保存できませんでした: ${(e as Error).message}`);
      if (e instanceof HttpError && e.status === 409) {
        const latest = await fetchSettings().catch(() => null);
        if (latest) setSettings(latest);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog ref={dialog} className="settings" onClose={props.onClose} aria-labelledby="settings-title">
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (!invalid && !unchanged) void submit(trimmed);
        }}
      >
        <header>
          <h2 id="settings-title">設定</h2>
          <button type="button" className="icon" aria-label="閉じる" onClick={() => dialog.current?.close()}>
            ×
          </button>
        </header>

        <label htmlFor="sip-uri">オペレーター接続先（PBX の SIP URI）</label>
        <input
          id="sip-uri"
          type="text"
          inputMode="url"
          spellCheck={false}
          autoComplete="off"
          placeholder="sip:2001@pbx.example.com"
          value={value}
          disabled={!settings || busy}
          aria-invalid={invalid}
          onChange={(e) => {
            setValue(e.target.value);
            setSaved(false);
          }}
        />
        {invalid && <p className="field-error">形式が正しくありません。例: sip:2001@pbx.example.com</p>}
        <p className="help">
          次の着信から反映されます。通話中の通話には影響しません。
          {settings && (
            <>
              <br />
              既定値（デプロイ時の設定）: <code>{settings.defaultSipTargetUri || '未設定'}</code>
              {settings.isDefault ? '（現在は既定値を使用中）' : ''}
              {settings.updatedAt && (
                <>
                  <br />
                  最終更新: {fmtDateTime(settings.updatedAt)}
                </>
              )}
            </>
          )}
        </p>
        {error && <div className="banner bad">{error}</div>}
        {saved && <div className="banner ok">保存しました。次の着信から反映されます。</div>}

        <footer>
          {settings && !settings.isDefault && (
            <button type="button" className="secondary" disabled={busy} onClick={() => void submit('')}>
              既定値に戻す
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="secondary" onClick={() => dialog.current?.close()}>
            閉じる
          </button>
          <button type="submit" className="primary" disabled={!settings || busy || invalid || unchanged || trimmed === ''}>
            {busy ? '保存中…' : '保存'}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
