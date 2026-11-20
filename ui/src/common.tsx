import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, type Resource } from "./api";

export function useToast() {
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const t = useRef<number>(0);
  const show = useCallback((text: string, error = false) => {
    setMsg({ text, error });
    window.clearTimeout(t.current);
    t.current = window.setTimeout(() => setMsg(null), error ? 8000 : 2500);
  }, []);
  const node = msg ? <div className={`toast ${msg.error ? "toast-error" : ""}`}>{msg.text}</div> : null;
  return { show, node };
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

export function CopyCmd({ cmd, label, hint }: { cmd: string; label?: string; hint?: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="copycmd">
      {label && <div className="copycmd-label">{label}</div>}
      <div className="copycmd-row">
        <code>{cmd}</code>
        <button
          className="btn btn-small"
          onClick={async () => {
            await copyText(cmd);
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          }}
        >
          {done ? "Skopiowano" : "Kopiuj"}
        </button>
      </div>
      {hint && <div className="muted small">{hint}</div>}
    </div>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const f = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? "modal-wide" : ""}`}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn btn-ghost" onClick={onClose} aria-label="Zamknij">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="muted small">{hint}</span>}
    </label>
  );
}

/** Kafelek pola: etykieta, skrót zawartości i przycisk „Dodaj” / „Edytuj” otwierający okno. */
export function EditTile({
  label,
  filled,
  summary,
  onClick,
  addLabel = "Dodaj",
  tone,
}: {
  label: string;
  filled: boolean;
  summary?: ReactNode;
  onClick: () => void;
  addLabel?: string;
  tone?: "warn";
}) {
  return (
    <div className={`tile ${filled ? "tile-filled" : "tile-empty"} ${tone ? `tile-${tone}` : ""}`}>
      <div className="grow">
        <div className="tile-label">{label}</div>
        {filled && summary && <div className="tile-summary">{summary}</div>}
      </div>
      <button className={`btn btn-small ${filled ? "" : "btn-primary"}`} onClick={onClick}>
        {filled ? "Edytuj" : addLabel}
      </button>
    </div>
  );
}

/** Skrót tekstu do kafelka. */
export function clip(text: string, n = 140) {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

/** Okno edycji jednego pola tekstowego. */
export function TextModal({
  title,
  value,
  hint,
  mono,
  rows = 12,
  placeholder,
  allowEmpty = true,
  resetLabel,
  onReset,
  onSave,
  onClose,
}: {
  title: string;
  value: string;
  hint?: ReactNode;
  mono?: boolean;
  rows?: number;
  placeholder?: string;
  allowEmpty?: boolean;
  resetLabel?: string;
  onReset?: () => void;
  onSave: (v: string) => Promise<unknown> | void;
  onClose: () => void;
}) {
  const [v, setV] = useState(value);
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onClose} wide>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!allowEmpty && !v.trim()) return;
          setBusy(true);
          try {
            await onSave(v);
            onClose();
          } finally {
            setBusy(false);
          }
        }}
      >
        {hint && <div className="muted small">{hint}</div>}
        <textarea autoFocus rows={rows} className={mono ? "mono" : ""} value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} />
        <div className="row-end">
          {onReset && (
            <button type="button" className="btn btn-ghost" onClick={() => {
                setV("");
                onReset();
              }}>
              {resetLabel ?? "Przywróć domyślne"}
            </button>
          )}
          <div className="grow" />
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Anuluj
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Zapisz
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Lista zasobów referencyjnych (tylko do odczytu); dodawanie przez okno. */
export function ResourcesEditor({
  scope,
  scopeId,
  onError,
  onChanged,
}: {
  scope: Resource["scope"];
  scopeId: number | null;
  onError: (m: string) => void;
  onChanged?: (count: number) => void;
}) {
  const [items, setItems] = useState<Resource[]>([]);
  const [adding, setAdding] = useState(false);
  const load = () =>
    api
      .get<Resource[]>(`/api/resources?scope=${scope}${scopeId != null ? `&scope_id=${scopeId}` : ""}`)
      .then((r) => {
        setItems(r);
        onChanged?.(r.length);
      })
      .catch((e) => onError(e.message));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, scopeId]);

  return (
    <div className="resources">
      {items.length === 0 && <div className="muted small">Brak zasobów.</div>}
      {items.map((r) => (
        <div key={r.id} className="resource-row">
          <span className={`tag tag-${r.kind}`}>{r.kind === "git" ? "git" : "ścieżka"}</span>
          <div className="grow">
            <div>
              <b>{r.name}</b> <span className="muted small mono">{r.location}</span>
            </div>
            {r.note && <div className="muted small">{r.note}</div>}
          </div>
          <button className="btn btn-ghost btn-small" onClick={() => api.del(`/api/resources/${r.id}`).then(load).catch((e) => onError(e.message))}>
            Usuń
          </button>
        </div>
      ))}
      <button className="btn btn-small align-start" onClick={() => setAdding(true)}>
        + Dodaj zasób
      </button>
      {adding && <ResourceModal scope={scope} scopeId={scopeId} onClose={() => setAdding(false)} onSaved={load} onError={onError} />}
    </div>
  );
}

function ResourceModal({
  scope,
  scopeId,
  onClose,
  onSaved,
  onError,
}: {
  scope: Resource["scope"];
  scopeId: number | null;
  onClose: () => void;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [note, setNote] = useState("");
  return (
    <Modal title="Nowy zasób referencyjny (tylko do odczytu)" onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (!location.trim()) return;
          api
            .post("/api/resources", { scope, scope_id: scopeId, name: name.trim(), location: location.trim(), note: note.trim() })
            .then(() => {
              onSaved();
              onClose();
            })
            .catch((err) => onError(err.message));
        }}
      >
        <Field label="Ścieżka lokalna lub URL repozytorium git" hint="URL git zostanie sklonowany do ~/.vk/cache przy pierwszej sesji.">
          <input autoFocus className="mono" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="~/projects/aplikacja-wzorcowa albo https://github.com/org/repo" />
        </Field>
        <Field label="Nazwa (opcjonalnie)">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="np. Aplikacja wzorcowa" />
        </Field>
        <Field label="Notatka dla agenta (opcjonalnie)">
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="np. wzorzec architektury modułów" />
        </Field>
        <div className="row-end">
          <button type="submit" className="btn btn-primary">
            Dodaj
          </button>
        </div>
      </form>
    </Modal>
  );
}
