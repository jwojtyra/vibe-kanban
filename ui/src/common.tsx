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

/** Lista zasobów referencyjnych (tylko do odczytu) dla danego zakresu. */
export function ResourcesEditor({
  scope,
  scopeId,
  onError,
}: {
  scope: Resource["scope"];
  scopeId: number | null;
  onError: (m: string) => void;
}) {
  const [items, setItems] = useState<Resource[]>([]);
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [note, setNote] = useState("");
  const load = () =>
    api
      .get<Resource[]>(`/api/resources?scope=${scope}${scopeId != null ? `&scope_id=${scopeId}` : ""}`)
      .then(setItems)
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
          <button
            className="btn btn-ghost btn-small"
            onClick={() => api.del(`/api/resources/${r.id}`).then(load).catch((e) => onError(e.message))}
          >
            Usuń
          </button>
        </div>
      ))}
      <form
        className="resource-add"
        onSubmit={(e) => {
          e.preventDefault();
          if (!location.trim()) return;
          api
            .post("/api/resources", { scope, scope_id: scopeId, name: name.trim(), location: location.trim(), note: note.trim() })
            .then(() => {
              setName("");
              setLocation("");
              setNote("");
              load();
            })
            .catch((e) => onError(e.message));
        }}
      >
        <input placeholder="Nazwa (np. Aplikacja wzorcowa)" value={name} onChange={(e) => setName(e.target.value)} />
        <input placeholder="Ścieżka lokalna lub URL repo git" value={location} onChange={(e) => setLocation(e.target.value)} className="grow" />
        <input placeholder="Notatka dla agenta (opcjonalnie)" value={note} onChange={(e) => setNote(e.target.value)} />
        <button className="btn btn-small" type="submit">
          Dodaj
        </button>
      </form>
    </div>
  );
}
