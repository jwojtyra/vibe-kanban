import { useCallback, useEffect, useState } from "react";
import { api, LEVEL_NAME, shortKey, STATUS_LABEL, type Comment, type DiffResult, type Item, type ItemStatus } from "./api";
import { CopyCmd, Field } from "./common";
import { DiffView, InlineComment } from "./DiffView";

type Tab = "details" | "review" | "log";

interface Form {
  repo: string;
  kind: "test" | "impl";
  title: string;
  description: string;
  problem: string;
  acceptance: string;
  depends_on: string[];
}

/** Panel boczny elementu planu: Etap, Funkcja albo Krok (z diffem, komentarzami i logiem). */
export function ItemPanel({
  itemId,
  taskKey,
  all,
  repos,
  onOpen,
  onAddChild,
  onClose,
  onChanged,
  onError,
  onToast,
}: {
  itemId: number;
  taskKey: string;
  all: Item[];
  repos: string[];
  onOpen: (id: number) => void;
  onAddChild: (parent: Item) => void;
  onClose: () => void;
  onChanged: () => void;
  onError: (m: string) => void;
  onToast: (m: string) => void;
}) {
  const [it, setIt] = useState<Item | null>(null);
  const [form, setForm] = useState<Form | null>(null);
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
        .get<Item>(`/api/items/${itemId}`)
        .then((x) => {
          setIt(x);
          setForm(
            (f) =>
              f ?? { repo: x.repo ?? "", kind: x.kind, title: x.title, description: x.description, problem: x.problem, acceptance: x.acceptance, depends_on: x.depends_on },
          );
          setTab((t) => t ?? (x.level === 3 && ["review", "done", "in_progress", "blocked"].includes(x.status) ? "review" : "details"));
        })
        .catch((e) => onError(e.message)),
    [itemId, onError],
  );
  const loadComments = useCallback(() => api.get<Comment[]>(`/api/items/${itemId}/comments`).then(setComments), [itemId]);
  const loadDiff = useCallback(
    () =>
      api
        .get<DiffResult>(`/api/items/${itemId}/diff`)
        .then(setDiff)
        .catch((e) => onError(e.message)),
    [itemId, onError],
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
      const f = () => api.get<{ kind: string; text: string }[]>(`/api/items/${itemId}/log`).then(setLog);
      f();
      const t = setInterval(f, 3000);
      return () => clearInterval(t);
    }
  }, [tab, itemId, loadDiff]);

  useEffect(() => {
    const f = (e: KeyboardEvent) => e.key === "Escape" && !(e.target instanceof HTMLTextAreaElement) && onClose();
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, [onClose]);

  if (!it || !form) return null;
  const isStep = it.level === 3;
  // Etap/Funkcja: edycja tylko, dopóki żaden z ich Kroków nie ruszył (status wyliczony draft/todo)
  const editable = isStep ? ["draft", "todo", "blocked"].includes(it.status) : ["draft", "todo"].includes(it.display_status);
  const sk = (k: string) => shortKey(taskKey, k);
  const upd = (p: Partial<Form>) => {
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
  const setStatus = (status: ItemStatus) => act(() => api.post(`/api/items/${it.id}/status`, { status }), `Status: ${STATUS_LABEL[status]}`);
  const resolve = (c: Comment) => api.put(`/api/comments/${c.id}`, { resolved: !c.resolved }).then(loadComments).then(onChanged);
  const del = (c: Comment) => api.del(`/api/comments/${c.id}`).then(loadComments).then(onChanged);
  const siblingsLevel = all.filter((x) => x.level === it.level && x.id !== it.id);
  const children = all.filter((x) => x.parent_id === it.id);
  const parents: Item[] = [];
  for (let p = all.find((x) => x.id === it.parent_id); p; p = all.find((x) => x.id === p!.parent_id)) parents.unshift(p);
  const generalComments = comments.filter((c) => !c.file);
  const fileComments = comments.filter((c) => c.file);

  return (
    <div className="drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="drawer">
        <div className="drawer-head">
          <div>
            {parents.length > 0 && (
              <div className="breadcrumb small">
                {parents.map((p) => (
                  <button key={p.id} className="linklike" onClick={() => onOpen(p.id)}>
                    {LEVEL_NAME[p.level]} {sk(p.key)}: {p.title}
                  </button>
                ))}
              </div>
            )}
            <div className="mono small muted">
              <span className={`level level-${it.level}`}>{LEVEL_NAME[it.level]}</span> {it.key} ·{" "}
              <span className={`status status-${it.display_status}`}>{STATUS_LABEL[it.display_status]}</span>
              {isStep && it.repo && (
                <>
                  {" "}
                  · repo <b>{it.repo}</b>
                </>
              )}
              {isStep && <span className={`kind kind-${it.kind}`}>{it.kind === "test" ? "testy" : "implementacja"}</span>}
              {it.branch && <> · {it.branch}</>}
            </div>
            <h2>{it.title}</h2>
          </div>
          <button className="btn btn-ghost" onClick={onClose} aria-label="Zamknij">
            ✕
          </button>
        </div>

        {it.error && <div className="alert">{it.error}</div>}

        <div className="drawer-actions">
          {it.status === "draft" && (
            <button className="btn btn-small" disabled={busy} onClick={() => setStatus("todo")}>
              Akceptuj → Todo
            </button>
          )}
          {it.status === "todo" && it.display_status === "todo" && (
            <button className="btn btn-small btn-ghost" disabled={busy} onClick={() => setStatus("draft")}>
              Cofnij do Draft
            </button>
          )}
          {isStep && it.status === "blocked" && (
            <button className="btn btn-small" disabled={busy} onClick={() => setStatus("todo")}>
              Przywróć do Todo
            </button>
          )}
          {isStep && (it.status === "review" || it.status === "blocked") && (
            <button className="btn btn-small btn-primary" disabled={busy} onClick={() => act(() => api.post(`/api/items/${it.id}/merge`), "Zaakceptowano — scalono do gałęzi ticketu")}>
              Akceptuj → Done (merge lokalny)
            </button>
          )}
          {isStep && it.status === "review" && (
            <button className="btn btn-small btn-ghost" disabled={busy} onClick={() => setStatus("todo")} title="Ponowne uruchomienie subagenta przez vk run / vk exec">
              Do ponownej realizacji
            </button>
          )}
          {isStep && it.status === "in_progress" && (
            <button className="btn btn-small btn-ghost" disabled={busy} onClick={() => setStatus("blocked")} title="Gdy proces subagenta został przerwany">
              Oznacz jako Blocked
            </button>
          )}
          {!isStep && (
            <button className="btn btn-small" onClick={() => onAddChild(it)}>
              + {LEVEL_NAME[it.level + 1]}
            </button>
          )}
          {it.status === "draft" && (
            <button
              className="btn btn-small btn-ghost btn-danger"
              disabled={busy}
              onClick={() => {
                if (confirm(`Usunąć ${it.key}${children.length ? " razem z elementami podrzędnymi" : ""}?`))
                  api
                    .del(`/api/items/${it.id}`)
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

        {isStep && it.commands && ["in_progress", "review", "blocked", "done"].includes(it.status) && (
          <div className="cmds">
            <CopyCmd cmd={it.commands.open} label="Sesja pracy nad Krokiem" hint="Stała sesja w worktree Kroku; zna komentarze z review, Funkcję i ticket." />
            {it.commands.agent && <CopyCmd cmd={it.commands.agent} label="Wznów sesję subagenta" hint="Z pełnym kontekstem agenta, który wykonał Krok." />}
          </div>
        )}
        {isStep && it.commands && ["todo", "blocked"].includes(it.status) && <CopyCmd cmd={it.commands.exec} label="Uruchom tylko ten Krok" />}

        {isStep && (
          <div className="tabs">
            <button className={tab === "details" ? "active" : ""} onClick={() => setTab("details")}>
              Szczegóły
            </button>
            <button className={tab === "review" ? "active" : ""} onClick={() => setTab("review")}>
              Diff i komentarze {it.open_comments > 0 && <span className="badge">{it.open_comments}</span>}
            </button>
            <button className={tab === "log" ? "active" : ""} onClick={() => setTab("log")}>
              Log subagenta
            </button>
          </div>
        )}

        {tab === "details" && (
          <div className="stack">
            {it.summary && (
              <div className="summary">
                <div className="field-label">Podsumowanie agenta</div>
                <div className="pre">{it.summary}</div>
              </div>
            )}
            {isStep && (
              <div className="grid2">
                <Field label="Repozytorium" hint={it.branch ? "Krok ma już gałąź — repozytorium nie może być zmienione." : undefined}>
                  <select disabled={!editable || !!it.branch} value={form.repo} onChange={(e) => upd({ repo: e.target.value })}>
                    {repos.map((r) => (
                      <option key={r}>{r}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Rodzaj">
                  <select disabled={!editable} value={form.kind} onChange={(e) => upd({ kind: e.target.value as Form["kind"] })}>
                    <option value="test">testy (czerwone)</option>
                    <option value="impl">implementacja</option>
                  </select>
                </Field>
              </div>
            )}
            <Field label="Tytuł">
              <input disabled={!editable} value={form.title} onChange={(e) => upd({ title: e.target.value })} />
            </Field>
            <Field label={it.level === 2 ? "Opis zmiany funkcjonalnej (API / zachowanie)" : "Opis"}>
              <textarea disabled={!editable} rows={5} value={form.description} onChange={(e) => upd({ description: e.target.value })} />
            </Field>
            {!isStep && (
              <Field label="Jaki problem rozwiązuje">
                <textarea disabled={!editable} rows={3} value={form.problem} onChange={(e) => upd({ problem: e.target.value })} />
              </Field>
            )}
            {it.level !== 1 && (
              <Field
                label={it.level === 2 ? "Testy akceptacyjne" : "Kryteria akceptacji Kroku"}
                hint={it.level === 2 ? "Scenariusze, które po realizacji Funkcji muszą być zielone (test-first: najpierw czerwone)." : undefined}
              >
                <textarea disabled={!editable} rows={4} value={form.acceptance} onChange={(e) => upd({ acceptance: e.target.value })} />
              </Field>
            )}
            <div className="field">
              <span className="field-label">Zależy od ({LEVEL_NAME[it.level]})</span>
              {it.level < 3 && <span className="muted small">Zależność {it.level === 1 ? "Etapu" : "Funkcji"} obowiązuje wszystkie jej Kroki.</span>}
              {siblingsLevel.length === 0 && <span className="muted small">Brak innych elementów tego poziomu.</span>}
              <div className="deps">
                {siblingsLevel.map((o) => (
                  <label key={o.id} className="dep">
                    <input
                      type="checkbox"
                      disabled={!editable}
                      checked={form.depends_on.includes(o.key)}
                      onChange={(e) => upd({ depends_on: e.target.checked ? [...form.depends_on, o.key] : form.depends_on.filter((k) => k !== o.key) })}
                    />
                    <span className="mono small">{sk(o.key)}</span> {o.title}{" "}
                    <span className="muted small">
                      ({o.repo ? `${o.repo}, ` : ""}
                      {STATUS_LABEL[o.display_status]})
                    </span>
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
                      .put<Item>(`/api/items/${it.id}`, isStep ? form : { ...form, repo: undefined, kind: undefined })
                      .then((x) => {
                        setIt({ ...it, ...x });
                        setDirty(false);
                        onChanged();
                        onToast("Zapisano");
                      })
                      .catch((e) => onError(e.message))
                  }
                >
                  Zapisz
                </button>
              </div>
            )}
            {!isStep && (
              <div className="field">
                <span className="field-label">{it.level === 1 ? "Funkcje" : "Kroki"}</span>
                {children.length === 0 && <span className="muted small">Brak — dodaj przyciskiem „+ {LEVEL_NAME[it.level + 1]}” lub w sesji planowania.</span>}
                {children.map((c) => (
                  <button key={c.id} className="child-row" onClick={() => onOpen(c.id)}>
                    <span className="mono small muted">{sk(c.key)}</span>
                    <span className="grow">{c.title}</span>
                    {c.repo && <span className="tag tag-repo">{c.repo}</span>}
                    {c.level === 3 && <span className={`kind kind-${c.kind}`}>{c.kind === "test" ? "testy" : "impl"}</span>}
                    <span className={`status status-${c.display_status} small`}>{STATUS_LABEL[c.display_status]}</span>
                  </button>
                ))}
              </div>
            )}
            {it.worktree_path && <div className="muted small mono">worktree: {it.worktree_path}</div>}
          </div>
        )}

        {isStep && tab === "review" && (
          <div className="stack">
            {diff && (
              <div className="diff-info small">
                <span>
                  repo <b>{diff.repo}</b> · baza: <span className="mono">{diff.baseRef}</span>
                </span>
                {diff.uncommitted && <span className="warn">niezacommitowane zmiany w worktree</span>}
                {diff.needsRebase && (
                  <>
                    <span className="warn">baza poszła do przodu</span>
                    <button className="btn btn-small" disabled={busy} onClick={() => act(() => api.post(`/api/items/${it.id}/rebase`), "Rebase wykonany")}>
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
                    .post(`/api/items/${it.id}/comments`, { body: general })
                    .then(() => {
                      setGeneral("");
                      loadComments();
                      onChanged();
                    })
                    .catch((err) => onError(err.message));
                }}
              >
                <textarea rows={2} value={general} placeholder="Komentarz do całego Kroku…" onChange={(e) => setGeneral(e.target.value)} />
                <div className="row-end">
                  <button className="btn btn-small" type="submit">
                    Dodaj
                  </button>
                </div>
              </form>
            </div>

            <p className="muted small">Kliknij linię w diffie, aby dodać komentarz. Komentarze widzi sesja otwarta poleceniem powyżej (vk_list_comments).</p>
            {diff ? (
              <DiffView
                diff={diff.diff}
                comments={fileComments}
                onResolve={resolve}
                onDelete={del}
                onAddComment={async (c) => {
                  try {
                    await api.post(`/api/items/${it.id}/comments`, c);
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

        {isStep && tab === "log" && (
          <div className="log">
            {log.length === 0 && <div className="muted">Brak logu (Krok nie był jeszcze realizowany przez subagenta).</div>}
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
