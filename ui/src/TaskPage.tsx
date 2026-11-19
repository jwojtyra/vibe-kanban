import { useCallback, useEffect, useState } from "react";
import { api, COLUMNS, LEVEL_NAME, shortKey, STATUS_LABEL, type Item, type Link, type Repo, type Task, type TaskView } from "./api";
import { CopyCmd, Field, Modal, ResourcesEditor } from "./common";
import { ItemPanel } from "./ItemPanel";
import { RepoPicker } from "./Repos";
import { PLACEHOLDERS } from "./Settings";

type Form = Pick<Task, "title" | "description" | "ticket_url" | "assumptions" | "links"> & {
  plan_prompt: string;
  impl_prompt: string;
  review_prompt: string;
};

const toForm = (t: Task): Form => ({
  title: t.title,
  description: t.description,
  ticket_url: t.ticket_url,
  assumptions: t.assumptions,
  links: t.links,
  plan_prompt: t.plan_prompt ?? "",
  impl_prompt: t.impl_prompt ?? "",
  review_prompt: t.review_prompt ?? "",
});

function LinksEditor({ links, onChange }: { links: Link[]; onChange: (l: Link[]) => void }) {
  const [url, setUrl] = useState("");
  const [note, setNote] = useState("");
  return (
    <div className="links">
      {links.map((l, i) => (
        <div key={i} className="resource-row">
          <div className="grow">
            <a href={l.url} target="_blank" rel="noreferrer" className="mono small">
              {l.url}
            </a>
            {l.note && <div className="muted small">{l.note}</div>}
          </div>
          <button className="btn btn-ghost btn-small" onClick={() => onChange(links.filter((_, j) => j !== i))}>
            Usuń
          </button>
        </div>
      ))}
      <div className="resource-add">
        <input className="grow" placeholder="https://… (dokumentacja, design, konwersacja…)" value={url} onChange={(e) => setUrl(e.target.value)} />
        <input placeholder="Do czego służy (opcjonalnie)" value={note} onChange={(e) => setNote(e.target.value)} />
        <button
          className="btn btn-small"
          onClick={() => {
            if (!url.trim()) return;
            onChange([...links, { url: url.trim(), note: note.trim() || undefined }]);
            setUrl("");
            setNote("");
          }}
        >
          Dodaj
        </button>
      </div>
    </div>
  );
}

function NewItemModal({
  level,
  parent,
  repos,
  defaultKind,
  onClose,
  onSubmit,
}: {
  level: 1 | 2 | 3;
  parent: Item | null;
  repos: string[];
  defaultKind: "test" | "impl";
  onClose: () => void;
  onSubmit: (d: Record<string, unknown>) => void;
}) {
  const [title, setTitle] = useState("");
  const [repo, setRepo] = useState(repos[0] ?? "");
  const [kind, setKind] = useState<"test" | "impl">(defaultKind);
  const [acceptance, setAcceptance] = useState("");
  return (
    <Modal title={`Nowy element: ${LEVEL_NAME[level]}${parent ? ` w ${parent.title}` : ""}`} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (!title.trim()) return;
          onSubmit({ level, parent: parent?.key, title: title.trim(), ...(level === 3 ? { repo, kind } : {}), ...(level === 2 ? { acceptance } : {}) });
        }}
      >
        <Field label="Tytuł">
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        {level === 2 && (
          <Field label="Testy akceptacyjne" hint="Scenariusze dowodzące, że funkcjonalność działa.">
            <textarea rows={3} value={acceptance} onChange={(e) => setAcceptance(e.target.value)} />
          </Field>
        )}
        {level === 3 && (
          <div className="grid2">
            <Field label="Repozytorium">
              <select value={repo} onChange={(e) => setRepo(e.target.value)}>
                {repos.map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
            </Field>
            <Field label="Rodzaj">
              <select value={kind} onChange={(e) => setKind(e.target.value as "test" | "impl")}>
                <option value="test">testy (czerwone)</option>
                <option value="impl">implementacja</option>
              </select>
            </Field>
          </div>
        )}
        <div className="row-end">
          <button className="btn btn-primary" type="submit">
            Dodaj (Draft)
          </button>
        </div>
      </form>
    </Modal>
  );
}

function StatusPill({ s }: { s: Item["display_status"] }) {
  return <span className={`pill pill-${s}`}>{STATUS_LABEL[s]}</span>;
}

function PlanTree({
  items,
  taskKey,
  onOpen,
  onMove,
  onAdd,
}: {
  items: Item[];
  taskKey: string;
  onOpen: (id: number) => void;
  onMove: (it: Item, dir: -1 | 1) => void;
  onAdd: (level: 1 | 2 | 3, parent: Item | null) => void;
}) {
  if (items.length === 0)
    return (
      <div className="empty-plan">
        <p>Plan jest pusty. Uruchom sesję planowania (krok 1) albo dodaj elementy ręcznie.</p>
        <button className="btn btn-small" onClick={() => onAdd(1, null)}>
          + Etap
        </button>
      </div>
    );
  return (
    <div className="plan">
      {items.map((it) => {
        const deps = it.depends_on.map((k) => shortKey(taskKey, k));
        const children = items.filter((c) => c.parent_id === it.id);
        const done = it.level < 3 ? items.filter((s) => s.level === 3 && s.key.startsWith(`${it.key}.`)) : [];
        return (
          <div key={it.id} className={`plan-row plan-l${it.level}`} onClick={() => onOpen(it.id)} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onOpen(it.id)}>
            <span className={`level level-${it.level}`}>{LEVEL_NAME[it.level]}</span>
            <span className="mono small muted plan-key">{shortKey(taskKey, it.key)}</span>
            <span className="plan-title">
              {it.title}
              {it.level === 2 && it.acceptance && (
                <span className="muted small"> · {it.acceptance.split("\n").filter((l) => l.trim()).length} test(y) akceptacyjne</span>
              )}
              {it.level === 2 && !it.acceptance && <span className="warn small"> · brak testów akceptacyjnych</span>}
            </span>
            {it.level === 3 && <span className="tag tag-repo">{it.repo}</span>}
            {it.level === 3 && <span className={`kind kind-${it.kind}`}>{it.kind === "test" ? "testy" : "impl"}</span>}
            {deps.length > 0 && <span className="muted small">⤷ {deps.join(", ")}</span>}
            {it.level < 3 && done.length > 0 && (
              <span className="muted small">
                {done.filter((s) => s.status === "done").length}/{done.length} kroków
              </span>
            )}
            {it.open_comments > 0 && <span className="badge">{it.open_comments} kom.</span>}
            <StatusPill s={it.display_status} />
            <span className="plan-actions" onClick={(e) => e.stopPropagation()}>
              {it.level < 3 && (
                <button className="btn btn-ghost btn-tiny" title={`Dodaj: ${LEVEL_NAME[it.level + 1]}`} onClick={() => onAdd((it.level + 1) as 2 | 3, it)}>
                  + {LEVEL_NAME[it.level + 1]}
                </button>
              )}
              {["draft", "todo"].includes(it.display_status) && (
                <>
                  <button className="btn btn-ghost btn-tiny" title="Wyżej" onClick={() => onMove(it, -1)}>
                    ↑
                  </button>
                  <button className="btn btn-ghost btn-tiny" title="Niżej" onClick={() => onMove(it, 1)}>
                    ↓
                  </button>
                </>
              )}
            </span>
            {it.level < 3 && children.length === 0 && <span className="muted small plan-hint">brak elementów podrzędnych</span>}
          </div>
        );
      })}
      <div className="row">
        <button className="btn btn-small" onClick={() => onAdd(1, null)}>
          + Etap
        </button>
      </div>
    </div>
  );
}

function StepCard({ s, items, taskKey, showRepo, onOpen }: { s: Item; items: Item[]; taskKey: string; showRepo: boolean; onOpen: () => void }) {
  const feature = items.find((i) => i.id === s.parent_id);
  return (
    <div className={`card card-${s.status}`} onClick={onOpen} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onOpen()}>
      <div className="card-top">
        <span className="mono small muted">{shortKey(taskKey, s.key)}</span>
        <span className={`kind kind-${s.kind}`}>{s.kind === "test" ? "testy" : "impl"}</span>
      </div>
      {feature && <div className="card-feature small muted">Funkcja: {feature.title}</div>}
      <div className="card-title">{s.title}</div>
      <div className="card-meta small">
        {showRepo && s.repo && <span className="tag tag-repo">{s.repo}</span>}
        {s.depends_on.length > 0 && <span className="muted">⤷ {s.depends_on.map((k) => shortKey(taskKey, k)).join(", ")}</span>}
        {s.open_comments > 0 && <span className="badge">{s.open_comments} kom.</span>}
        {s.error && <span className="warn">błąd</span>}
      </div>
    </div>
  );
}

export function TaskPage({
  taskId,
  allRepos,
  onError,
  onToast,
  onChanged,
  onOpenRepos,
  onDeleted,
}: {
  taskId: number;
  allRepos: Repo[];
  onError: (m: string) => void;
  onToast: (m: string) => void;
  onChanged: () => void;
  onOpenRepos: () => void;
  onDeleted: () => void;
}) {
  const [view, setView] = useState<TaskView | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [dirty, setDirty] = useState(false);
  const [showDetails, setShowDetails] = useState<boolean | null>(null);
  const [showPrompts, setShowPrompts] = useState(false);
  const [openItem, setOpenItem] = useState<number | null>(null);
  const [newItem, setNewItem] = useState<{ level: 1 | 2 | 3; parent: Item | null } | null>(null);
  const [mode, setMode] = useState<"plan" | "board">("plan");
  const [repoFilter, setRepoFilter] = useState("");
  const [featureFilter, setFeatureFilter] = useState("");

  const load = useCallback(
    () =>
      api
        .get<TaskView>(`/api/tasks/${taskId}`)
        .then((v) => {
          setView(v);
          setForm((f) => f ?? toForm(v.task));
          setShowDetails((d) => (d === null ? v.items.length === 0 : d));
        })
        .catch((e) => onError(e.message)),
    [taskId, onError],
  );

  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);

  if (!view || !form) return <div className="pad muted">Ładowanie…</div>;
  const { task, commands, items } = view;
  const repoNames = view.repos.map((r) => r.name);
  const steps = items.filter((i) => i.level === 3);
  const drafts = items.filter((i) => i.status === "draft");
  const todo = steps.filter((s) => s.status === "todo");
  const features = items.filter((i) => i.level === 2);
  const filteredSteps = steps.filter(
    (s) => (!repoFilter || s.repo === repoFilter) && (!featureFilter || items.find((i) => i.id === s.parent_id)?.key === featureFilter),
  );

  const upd = (patch: Partial<Form>) => {
    setForm({ ...form, ...patch });
    setDirty(true);
  };
  const save = () =>
    api
      .put<TaskView>(`/api/tasks/${taskId}`, form)
      .then((v) => {
        setView(v);
        setForm(toForm(v.task));
        setDirty(false);
        onChanged();
        onToast("Zapisano ticket");
      })
      .catch((e) => onError(e.message));
  const toggleRepo = (name: string, on: boolean) => {
    const repo = allRepos.find((r) => r.name === name);
    if (!repo) return;
    (on ? api.post<TaskView>(`/api/tasks/${taskId}/repos`, { repo: name }) : api.del<TaskView>(`/api/tasks/${taskId}/repos/${repo.id}`))
      .then((v) => {
        setView(v);
        onChanged();
      })
      .catch((e) => onError(e.message));
  };
  const move = (it: Item, dir: -1 | 1) => {
    const sib = items.filter((x) => x.parent_id === it.parent_id).map((x) => x.key);
    const i = sib.indexOf(it.key);
    const j = i + dir;
    if (j < 0 || j >= sib.length) return;
    [sib[i], sib[j]] = [sib[j], sib[i]];
    api.post<TaskView>(`/api/tasks/${taskId}/reorder`, { order: sib }).then(setView).catch((e) => onError(e.message));
  };
  const addItem = (d: Record<string, unknown>) =>
    api
      .post<Item>(`/api/tasks/${taskId}/items`, d)
      .then((it) => {
        setNewItem(null);
        load();
        setOpenItem(it.id);
      })
      .catch((e) => onError(e.message));

  return (
    <div className="task-page">
      <div className="task-head">
        <div>
          <div className="mono muted small">
            {task.key} · gałąź {view.task_branch}
            {view.task_repos.length > 0 && <> w: {view.task_repos.map((r) => r.name).join(", ")}</>}
            {task.ticket_url && (
              <>
                {" · "}
                <a href={task.ticket_url} target="_blank" rel="noreferrer">
                  ticket {task.ticket_id}
                </a>
              </>
            )}
          </div>
          <h1>{task.title}</h1>
          <div className="task-repos">
            <span className="muted small">Repozytoria:</span>
            <RepoPicker all={allRepos} selected={repoNames} onToggle={toggleRepo} />
            <button className="btn btn-ghost btn-tiny" onClick={onOpenRepos}>
              zarządzaj…
            </button>
          </div>
        </div>
        <div className="row">
          <button className="btn btn-small btn-ghost" onClick={() => setShowDetails(!showDetails)}>
            {showDetails ? "Ukryj szczegóły" : "Szczegóły ticketu"}
          </button>
          <button
            className="btn btn-small btn-ghost btn-danger"
            onClick={() => {
              if (confirm(`Usunąć ticket ${task.key}? (gałęzie i worktree zostają na dysku)`)) api.del(`/api/tasks/${taskId}`).then(onDeleted).catch((e) => onError(e.message));
            }}
          >
            Usuń
          </button>
        </div>
      </div>

      {showDetails && (
        <section className="panel">
          <div className="grid2">
            <div className="stack">
              <Field label="Tytuł">
                <input value={form.title} onChange={(e) => upd({ title: e.target.value })} />
              </Field>
              <Field label="Link do ticketu" hint={task.ticket_id ? `ID: ${task.ticket_id}` : "ID wyciągane automatycznie z linku"}>
                <input value={form.ticket_url} onChange={(e) => upd({ ticket_url: e.target.value })} placeholder="https://…/browse/PROJ-123" />
              </Field>
              <Field label="Opis">
                <textarea rows={6} value={form.description} onChange={(e) => upd({ description: e.target.value })} />
              </Field>
              <Field label="Własne założenia" hint="Np. ograniczenia, decyzje architektoniczne, czego nie ruszać. Założenia globalne są w Ustawieniach.">
                <textarea rows={5} value={form.assumptions} onChange={(e) => upd({ assumptions: e.target.value })} />
              </Field>
            </div>
            <div className="stack">
              <div className="field">
                <span className="field-label">Linki, z których ma korzystać agent</span>
                <LinksEditor links={form.links} onChange={(links) => upd({ links })} />
              </div>
              <div className="field">
                <span className="field-label">Zasoby referencyjne ticketu (tylko do odczytu)</span>
                <span className="muted small">Dodatkowo do sesji trafiają zasoby globalne.</span>
                <ResourcesEditor scope="task" scopeId={task.id} onError={onError} />
              </div>
              <button className="btn btn-ghost btn-small align-start" onClick={() => setShowPrompts(!showPrompts)}>
                {showPrompts ? "▾" : "▸"} Prompty tego ticketu {task.plan_prompt || task.impl_prompt || task.review_prompt ? "(nadpisane)" : "(domyślne)"}
              </button>
            </div>
          </div>
          {showPrompts && (
            <div className="stack">
              <p className="muted small">Puste pole = prompt domyślny z Ustawień. Placeholdery: {PLACEHOLDERS}</p>
              <Field label="Prompt planowania">
                <textarea rows={8} className="mono" value={form.plan_prompt} onChange={(e) => upd({ plan_prompt: e.target.value })} />
              </Field>
              <Field label="Prompt implementacji Kroku">
                <textarea rows={8} className="mono" value={form.impl_prompt} onChange={(e) => upd({ impl_prompt: e.target.value })} />
              </Field>
              <Field label="Prompt review Kroku">
                <textarea rows={6} className="mono" value={form.review_prompt} onChange={(e) => upd({ review_prompt: e.target.value })} />
              </Field>
            </div>
          )}
          <div className="row-end">
            {dirty && <span className="muted small">Niezapisane zmiany</span>}
            <button className="btn btn-ghost" disabled={!dirty} onClick={() => (setForm(toForm(task)), setDirty(false))}>
              Odrzuć
            </button>
            <button className="btn btn-primary" disabled={!dirty} onClick={save}>
              Zapisz
            </button>
          </div>
        </section>
      )}

      <section className="steps">
        <div className="step">
          <div className="step-num">1</div>
          <div className="grow">
            <div className="step-title">Planowanie {commands.plan_session_started && <span className="badge">sesja istnieje — zostanie wznowiona</span>}</div>
            <CopyCmd cmd={commands.plan} hint="Stała sesja Claude: analiza i rozbicie na Etapy → Funkcje (z testami akceptacyjnymi) → Kroki." />
          </div>
        </div>
        <div className="step">
          <div className="step-num">2</div>
          <div className="grow">
            <div className="step-title">Akceptacja planu</div>
            <button
              className="btn btn-primary btn-small"
              disabled={drafts.length === 0}
              onClick={() =>
                api
                  .post<TaskView>(`/api/tasks/${taskId}/accept-plan`)
                  .then((v) => {
                    setView(v);
                    onChanged();
                    onToast("Plan zaakceptowany");
                  })
                  .catch((e) => onError(e.message))
              }
            >
              Akceptuj cały plan ({drafts.length})
            </button>
            <div className="muted small">Możesz też akceptować pojedyncze Etapy/Funkcje/Kroki w ich panelu.</div>
          </div>
        </div>
        <div className="step">
          <div className="step-num">3</div>
          <div className="grow">
            <div className="step-title">Realizacja {todo.length > 0 && <span className="badge">Todo: {todo.length}</span>}</div>
            <CopyCmd cmd={commands.run} hint="Subagenci wykonują Kroki wg kolejności i zależności, każdy w osobnym worktree; wynik trafia do Review." />
          </div>
        </div>
      </section>

      <div className="view-switch">
        <div className="segmented">
          <button className={mode === "plan" ? "active" : ""} onClick={() => setMode("plan")}>
            Plan ({items.length})
          </button>
          <button className={mode === "board" ? "active" : ""} onClick={() => setMode("board")}>
            Tablica kroków ({steps.length})
          </button>
        </div>
        {mode === "board" && (
          <div className="repo-filter">
            {repoNames.length > 1 &&
              ["", ...repoNames].map((r) => (
                <button key={r || "all"} className={`chip ${repoFilter === r ? "active" : ""}`} onClick={() => setRepoFilter(r)}>
                  {r || "wszystkie repo"}
                </button>
              ))}
            {features.length > 1 && (
              <select className="feature-filter" value={featureFilter} onChange={(e) => setFeatureFilter(e.target.value)}>
                <option value="">Wszystkie funkcje</option>
                {features.map((f) => (
                  <option key={f.id} value={f.key}>
                    {shortKey(task.key, f.key)} {f.title}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}
      </div>

      {mode === "plan" ? (
        <PlanTree items={items} taskKey={task.key} onOpen={setOpenItem} onMove={move} onAdd={(level, parent) => setNewItem({ level, parent })} />
      ) : (
        <section className="board">
          {COLUMNS.filter((c) => c !== "blocked" || steps.some((s) => s.status === "blocked")).map((col) => {
            const colItems = filteredSteps.filter((s) => s.status === col);
            return (
              <div key={col} className={`column column-${col}`}>
                <div className="column-head">
                  {STATUS_LABEL[col]} <span className="muted">{colItems.length}</span>
                </div>
                <div className="column-body">
                  {colItems.map((s) => (
                    <StepCard key={s.id} s={s} items={items} taskKey={task.key} showRepo={repoNames.length > 1} onOpen={() => setOpenItem(s.id)} />
                  ))}
                </div>
              </div>
            );
          })}
        </section>
      )}

      {newItem && (
        <NewItemModal
          level={newItem.level}
          parent={newItem.parent}
          repos={repoNames}
          defaultKind={items.some((i) => i.parent_id === newItem.parent?.id) ? "impl" : "test"}
          onClose={() => setNewItem(null)} onSubmit={addItem} />
      )}

      {openItem != null && (
        <ItemPanel
          key={openItem}
          itemId={openItem}
          taskKey={task.key}
          all={items}
          repos={repoNames}
          onOpen={setOpenItem}
          onAddChild={(p) => setNewItem({ level: (p.level + 1) as 2 | 3, parent: p })}
          onClose={() => setOpenItem(null)}
          onChanged={() => {
            load();
            onChanged();
          }}
          onError={onError}
          onToast={onToast}
        />
      )}
    </div>
  );
}
