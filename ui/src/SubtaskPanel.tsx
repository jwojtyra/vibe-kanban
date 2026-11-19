import { useCallback, useEffect, useState } from "react";
import { api, STATUS_LABEL, type Comment, type DiffResult, type Subtask } from "./api";
import { CopyCmd, Field } from "./common";
import { DiffView, InlineComment } from "./DiffView";

type Tab = "details" | "review" | "log";

export function SubtaskPanel({
  subtaskId,
  all,
  onClose,
  onChanged,
  onError,
  onToast,
}: {
  subtaskId: number;
  all: Subtask[];
  onClose: () => void;
  onChanged: () => void;
  onError: (m: string) => void;
  onToast: (m: string) => void;
}) {
  const [s, setS] = useState<Subtask | null>(null);
  const [form, setForm] = useState<{ title: string; description: string; problem: string; acceptance: string; depends_on: string[] } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<Tab | null>(null);
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [log, setLog] = useState<{ kind: string; text: string }[]>([]);
  const [general, setGeneral] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    () =>
      api
        .get<Subtask>(`/api/subtasks/${subtaskId}`)
        .then((x) => {
          setS(x);
          setForm((f) => f ?? { title: x.title, description: x.description, problem: x.problem, acceptance: x.acceptance, depends_on: x.depends_on });
          setTab((t) => t ?? (["review", "done", "in_progress", "blocked"].includes(x.status) ? "review" : "details"));
        })
        .catch((e) => onError(e.message)),
    [subtaskId, onError],
  );
  const loadComments = useCallback(() => api.get<Comment[]>(`/api/subtasks/${subtaskId}/comments`).then(setComments), [subtaskId]);
  const loadDiff = useCallback(
    () =>
      api
        .get<DiffResult>(`/api/subtasks/${subtaskId}/diff`)
        .then(setDiff)
        .catch((e) => onError(e.message)),
    [subtaskId, onError],
  );

  useEffect(() => {
    load();
    loadComments();
    const t = setInterval(() => {
      load();
      loadComments();
    }, 4000);
    return () => clearInterval(t);
  }, [load, loadComments]);

  useEffect(() => {
    if (tab === "review") loadDiff();
    if (tab === "log") {
      const f = () => api.get<{ kind: string; text: string }[]>(`/api/subtasks/${subtaskId}/log`).then(setLog);
      f();
      const t = setInterval(f, 3000);
      return () => clearInterval(t);
    }
  }, [tab, subtaskId, loadDiff]);

  useEffect(() => {
    const f = (e: KeyboardEvent) => e.key === "Escape" && !(e.target instanceof HTMLTextAreaElement) && onClose();
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, [onClose]);

  if (!s || !form) return null;
  const editable = ["draft", "todo", "blocked"].includes(s.status);
  const upd = (p: Partial<typeof form>) => {
    setForm({ ...form, ...p });
    setDirty(true);
  };
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true);
    try {
      await fn();
      onToast(msg);
      await load();
      onChanged();
      if (tab === "review") await loadDiff();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const setStatus = (status: string) => act(() => api.post(`/api/subtasks/${s.id}/status`, { status }), `Status: ${STATUS_LABEL[status as keyof typeof STATUS_LABEL]}`);
  const resolve = (c: Comment) => api.put(`/api/comments/${c.id}`, { resolved: !c.resolved }).then(loadComments).then(onChanged);
  const del = (c: Comment) => api.del(`/api/comments/${c.id}`).then(loadComments).then(onChanged);
  const others = all.filter((x) => x.id !== s.id);
  const generalComments = comments.filter((c) => !c.file);
  const fileComments = comments.filter((c) => c.file);

  return (
    <div className="drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="drawer">
        <div className="drawer-head">
          <div>
            <div className="mono small muted">
              {s.key} · <span className={`status status-${s.status}`}>{STATUS_LABEL[s.status]}</span>
              {s.branch && <> · {s.branch}</>}
            </div>
            <h2>{s.title}</h2>
          </div>
          <button className="btn btn-ghost" onClick={onClose} aria-label="Zamknij">
            ✕
          </button>
        </div>

        {s.error && <div className="alert">{s.error}</div>}

        <div className="drawer-actions">
          {s.status === "draft" && (
            <button className="btn btn-small" disabled={busy} onClick={() => setStatus("todo")}>
              Akceptuj → Todo
            </button>
          )}
          {s.status === "todo" && (
            <button className="btn btn-small btn-ghost" disabled={busy} onClick={() => setStatus("draft")}>
              Cofnij do Draft
            </button>
          )}
          {s.status === "blocked" && (
            <button className="btn btn-small" disabled={busy} onClick={() => setStatus("todo")}>
              Przywróć do Todo
            </button>
          )}
          {(s.status === "review" || s.status === "blocked") && (
            <button className="btn btn-small btn-primary" disabled={busy} onClick={() => act(() => api.post(`/api/subtasks/${s.id}/merge`), "Zaakceptowano — scalono do gałęzi zadania")}>
              Akceptuj → Done (merge lokalny)
            </button>
          )}
          {s.status === "review" && (
            <button className="btn btn-small btn-ghost" disabled={busy} onClick={() => setStatus("todo")} title="Ponowne uruchomienie subagenta przez vk run / vk exec">
              Do ponownej realizacji
            </button>
          )}
          {s.status === "in_progress" && (
            <button className="btn btn-small btn-ghost" disabled={busy} onClick={() => setStatus("blocked")} title="Gdy proces subagenta został przerwany">
              Oznacz jako Blocked
            </button>
          )}
          {["draft", "todo"].includes(s.status) && (
            <button
              className="btn btn-small btn-ghost btn-danger"
              disabled={busy}
              onClick={() => {
                if (confirm(`Usunąć ${s.key}?`))
                  api
                    .del(`/api/subtasks/${s.id}`)
                    .then(() => {
                      onChanged();
                      onClose();
                    })
                    .catch((e) => onError(e.message));
              }}
            >
              Usuń
            </button>
          )}
        </div>

        {["in_progress", "review", "blocked", "done"].includes(s.status) && (
          <div className="cmds">
            <CopyCmd cmd={s.commands.open} label="Sesja pracy nad podzadaniem" hint="Stała sesja w worktree podzadania; zna komentarze z review i zadanie główne." />
            {s.commands.agent && <CopyCmd cmd={s.commands.agent} label="Wznów sesję subagenta" hint="Z pełnym kontekstem agenta, który implementował." />}
          </div>
        )}
        {["todo", "blocked"].includes(s.status) && <CopyCmd cmd={s.commands.exec} label="Uruchom tylko to podzadanie" />}

        <div className="tabs">
          <button className={tab === "details" ? "active" : ""} onClick={() => setTab("details")}>
            Szczegóły
          </button>
          <button className={tab === "review" ? "active" : ""} onClick={() => setTab("review")}>
            Diff i komentarze {s.open_comments > 0 && <span className="badge">{s.open_comments}</span>}
          </button>
          <button className={tab === "log" ? "active" : ""} onClick={() => setTab("log")}>
            Log subagenta
          </button>
        </div>

        {tab === "details" && (
          <div className="stack">
            {s.summary && (
              <div className="summary">
                <div className="field-label">Podsumowanie agenta</div>
                <div className="pre">{s.summary}</div>
              </div>
            )}
            <Field label="Tytuł">
              <input disabled={!editable} value={form.title} onChange={(e) => upd({ title: e.target.value })} />
            </Field>
            <Field label="Opis — co zrobić">
              <textarea disabled={!editable} rows={6} value={form.description} onChange={(e) => upd({ description: e.target.value })} />
            </Field>
            <Field label="Jaki problem rozwiązuje">
              <textarea disabled={!editable} rows={3} value={form.problem} onChange={(e) => upd({ problem: e.target.value })} />
            </Field>
            <Field label="Kryteria akceptacji">
              <textarea disabled={!editable} rows={4} value={form.acceptance} onChange={(e) => upd({ acceptance: e.target.value })} />
            </Field>
            <div className="field">
              <span className="field-label">Zależy od</span>
              {others.length === 0 && <span className="muted small">Brak innych podzadań.</span>}
              <div className="deps">
                {others.map((o) => (
                  <label key={o.id} className="dep">
                    <input
                      type="checkbox"
                      disabled={!editable}
                      checked={form.depends_on.includes(o.key)}
                      onChange={(e) => upd({ depends_on: e.target.checked ? [...form.depends_on, o.key] : form.depends_on.filter((k) => k !== o.key) })}
                    />
                    <span className="mono small">{o.key}</span> {o.title} <span className="muted small">({STATUS_LABEL[o.status]})</span>
                  </label>
                ))}
              </div>
            </div>
            {editable && (
              <div className="row-end">
                <button
                  className="btn btn-primary"
                  disabled={!dirty}
                  onClick={() =>
                    api
                      .put<Subtask>(`/api/subtasks/${s.id}`, form)
                      .then((x) => {
                        setS({ ...s, ...x });
                        setDirty(false);
                        onChanged();
                        onToast("Zapisano podzadanie");
                      })
                      .catch((e) => onError(e.message))
                  }
                >
                  Zapisz
                </button>
              </div>
            )}
            {s.worktree_path && <div className="muted small mono">worktree: {s.worktree_path}</div>}
          </div>
        )}

        {tab === "review" && (
          <div className="stack">
            {diff && (
              <div className="diff-info small">
                <span>
                  baza: <span className="mono">{diff.baseRef}</span>
                </span>
                {diff.uncommitted && <span className="warn">niezacommitowane zmiany w worktree</span>}
                {diff.needsRebase && (
                  <>
                    <span className="warn">baza poszła do przodu</span>
                    <button className="btn btn-small" disabled={busy} onClick={() => act(() => api.post(`/api/subtasks/${s.id}/rebase`), "Rebase wykonany")}>
                      Rebase
                    </button>
                  </>
                )}
                <button className="btn btn-ghost btn-small" onClick={loadDiff}>
                  Odśwież diff
                </button>
              </div>
            )}
            {diff?.commits && <pre className="commits mono small">{diff.commits}</pre>}

            <div className="general-comments">
              <div className="field-label">Komentarze ogólne</div>
              {generalComments.map((c) => (
                <InlineComment key={c.id} c={c} onResolve={resolve} onDelete={del} />
              ))}
              <form
                className="comment-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!general.trim()) return;
                  api
                    .post(`/api/subtasks/${s.id}/comments`, { body: general })
                    .then(() => {
                      setGeneral("");
                      loadComments();
                      onChanged();
                    })
                    .catch((err) => onError(err.message));
                }}
              >
                <textarea rows={2} value={general} placeholder="Komentarz do całego podzadania…" onChange={(e) => setGeneral(e.target.value)} />
                <div className="row-end">
                  <button className="btn btn-small" type="submit">
                    Dodaj
                  </button>
                </div>
              </form>
            </div>

            <p className="muted small">Kliknij linię w diffie, aby dodać komentarz. Komentarze widzi sesja otwarta poleceniem powyżej (narzędzie vk_list_comments).</p>
            {diff ? (
              <DiffView
                diff={diff.diff}
                comments={fileComments}
                onResolve={resolve}
                onDelete={del}
                onAddComment={async (c) => {
                  try {
                    await api.post(`/api/subtasks/${s.id}/comments`, c);
                    await loadComments();
                    onChanged();
                  } catch (e) {
                    onError((e as Error).message);
                  }
                }}
              />
            ) : (
              <div className="muted">Ładowanie diffu…</div>
            )}
          </div>
        )}

        {tab === "log" && (
          <div className="log">
            {log.length === 0 && <div className="muted">Brak logu (podzadanie nie było jeszcze realizowane przez subagenta).</div>}
            {log.map((l, i) => (
              <div key={i} className={`log-${l.kind}`}>
                {l.kind === "tool" ? "→ " : ""}
                {l.text}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
