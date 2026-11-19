import { useCallback, useEffect, useState } from "react";
import { api, COLUMNS, STATUS_LABEL, type Link, type Subtask, type Task, type TaskView } from "./api";
import { CopyCmd, Field, Modal, ResourcesEditor } from "./common";
import { PLACEHOLDERS } from "./Settings";
import { SubtaskPanel } from "./SubtaskPanel";

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

function Card({ s, all, showRepo, onOpen, onMove }: { s: Subtask; all: Subtask[]; showRepo: boolean; onOpen: () => void; onMove?: (dir: -1 | 1) => void }) {
  const deps = s.depends_on.map((k) => all.find((x) => x.key === k));
  const waiting = deps.some((d) => d && !["review", "done"].includes(d.status));
  return (
    <div className={`card card-${s.status}`} onClick={onOpen} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onOpen()}>
      <div className="card-top">
        <span className="mono small muted">
          #{s.position} · {s.key}
        </span>
        {onMove && (
          <span className="card-move" onClick={(e) => e.stopPropagation()}>
            <button className="btn btn-ghost btn-tiny" title="Wyżej" onClick={() => onMove(-1)}>
              ↑
            </button>
            <button className="btn btn-ghost btn-tiny" title="Niżej" onClick={() => onMove(1)}>
              ↓
            </button>
          </span>
        )}
      </div>
      {showRepo && s.repo && <span className="tag tag-repo card-repo">{s.repo}</span>}
      <div className="card-title">{s.title}</div>
      {s.problem && <div className="card-problem small muted">{s.problem}</div>}
      <div className="card-meta small">
        {s.depends_on.length > 0 && (
          <span className={waiting ? "warn" : "muted"} title="Zależności">
            ⤷ {s.depends_on.map((k) => k.split("-").pop()).join(", ")}
          </span>
        )}
        {s.open_comments > 0 && <span className="badge">{s.open_comments} kom.</span>}
        {s.error && <span className="warn">błąd</span>}
      </div>
    </div>
  );
}

function NewSubtaskModal({ repos, onClose, onSubmit }: { repos: string[]; onClose: () => void; onSubmit: (d: { title: string; repo: string }) => void }) {
  const [title, setTitle] = useState("");
  const [repo, setRepo] = useState(repos[0] ?? "");
  return (
    <Modal title="Nowe podzadanie" onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim()) onSubmit({ title: title.trim(), repo });
        }}
      >
        <Field label="Tytuł">
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Repozytorium">
          <select value={repo} onChange={(e) => setRepo(e.target.value)}>
            {repos.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </Field>
        <div className="row-end">
          <button className="btn btn-primary" type="submit">
            Dodaj (Draft)
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function TaskPage({
  taskId,
  onError,
  onToast,
  onChanged,
  onDeleted,
}: {
  taskId: number;
  onError: (m: string) => void;
  onToast: (m: string) => void;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const [view, setView] = useState<TaskView | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [dirty, setDirty] = useState(false);
  const [showDetails, setShowDetails] = useState<boolean | null>(null);
  const [showPrompts, setShowPrompts] = useState(false);
  const [openSub, setOpenSub] = useState<number | null>(null);
  const [newSub, setNewSub] = useState(false);
  const [repoFilter, setRepoFilter] = useState<string>("");

  const load = useCallback(
    () =>
      api
        .get<TaskView>(`/api/tasks/${taskId}`)
        .then((v) => {
          setView(v);
          setForm((f) => f ?? toForm(v.task));
          setShowDetails((d) => (d === null ? v.subtasks.length === 0 : d));
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
  const { task, commands } = view;
  const repoNames = view.project.repos.map((r) => r.name);
  const multiRepo = repoNames.length > 1;
  const subtasks = repoFilter ? view.subtasks.filter((s) => s.repo === repoFilter) : view.subtasks;
  const drafts = subtasks.filter((s) => s.status === "draft");
  const todo = subtasks.filter((s) => s.status === "todo");
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
        onToast("Zapisano zadanie");
      })
      .catch((e) => onError(e.message));

  const move = (s: Subtask, dir: -1 | 1) => {
    const order = view.subtasks.map((x) => x.key);
    const i = order.indexOf(s.key);
    const j = i + dir;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    api.post<TaskView>(`/api/tasks/${taskId}/reorder`, { order }).then(setView).catch((e) => onError(e.message));
  };

  const addSubtask = (d: { title: string; repo: string }) =>
    api
      .post<Subtask>(`/api/tasks/${taskId}/subtasks`, d)
      .then((s) => {
        setNewSub(false);
        load();
        setOpenSub(s.id);
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
        </div>
        <div className="row">
          <button className="btn btn-small btn-ghost" onClick={() => setShowDetails(!showDetails)}>
            {showDetails ? "Ukryj szczegóły" : "Szczegóły zadania"}
          </button>
          <button
            className="btn btn-small btn-ghost btn-danger"
            onClick={() => {
              if (confirm(`Usunąć zadanie ${task.key}? (gałęzie i worktree zostają na dysku)`))
                api.del(`/api/tasks/${taskId}`).then(onDeleted).catch((e) => onError(e.message));
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
              <Field label="Własne założenia" hint="Np. ograniczenia, decyzje architektoniczne, czego nie ruszać.">
                <textarea rows={5} value={form.assumptions} onChange={(e) => upd({ assumptions: e.target.value })} />
              </Field>
            </div>
            <div className="stack">
              <div className="field">
                <span className="field-label">Linki, z których ma korzystać agent</span>
                <LinksEditor links={form.links} onChange={(links) => upd({ links })} />
              </div>
              <div className="field">
                <span className="field-label">Zasoby referencyjne zadania (tylko do odczytu)</span>
                <span className="muted small">Dodatkowo do sesji trafiają zasoby globalne i projektu.</span>
                <ResourcesEditor scope="task" scopeId={task.id} onError={onError} />
              </div>
              <button className="btn btn-ghost btn-small align-start" onClick={() => setShowPrompts(!showPrompts)}>
                {showPrompts ? "▾" : "▸"} Prompty tego zadania {task.plan_prompt || task.impl_prompt || task.review_prompt ? "(nadpisane)" : "(domyślne)"}
              </button>
            </div>
          </div>
          {showPrompts && (
            <div className="stack">
              <p className="muted small">Puste pole = prompt domyślny z Ustawień. Placeholdery: {PLACEHOLDERS}</p>
              <Field label="Prompt planowania">
                <textarea rows={8} className="mono" value={form.plan_prompt} onChange={(e) => upd({ plan_prompt: e.target.value })} />
              </Field>
              <Field label="Prompt implementacji">
                <textarea rows={8} className="mono" value={form.impl_prompt} onChange={(e) => upd({ impl_prompt: e.target.value })} />
              </Field>
              <Field label="Prompt review">
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
            <CopyCmd cmd={commands.plan} hint="Otwiera w terminalu zawsze tę samą sesję Claude, która zna kanban i rozbija zadanie na podzadania." />
          </div>
        </div>
        <div className="step">
          <div className="step-num">2</div>
          <div className="grow">
            <div className="step-title">Akceptacja planu</div>
            <div className="row">
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
                Akceptuj plan ({drafts.length})
              </button>
              <button className="btn btn-small" disabled={repoNames.length === 0} onClick={() => setNewSub(true)}>
                + Podzadanie ręcznie
              </button>
            </div>
            <div className="muted small">Przed akceptacją możesz edytować podzadania, kolejność i zależności.</div>
          </div>
        </div>
        <div className="step">
          <div className="step-num">3</div>
          <div className="grow">
            <div className="step-title">Realizacja {todo.length > 0 && <span className="badge">{todo.length} w Todo</span>}</div>
            <CopyCmd cmd={commands.run} hint="Subagenci realizują podzadania po kolei (wg zależności) w osobnych worktree; wynik trafia do Review." />
          </div>
        </div>
      </section>

      {multiRepo && (
        <div className="repo-filter">
          <span className="muted small">Repozytorium:</span>
          {["", ...repoNames].map((r) => (
            <button key={r || "all"} className={`chip ${repoFilter === r ? "active" : ""}`} onClick={() => setRepoFilter(r)}>
              {r || "wszystkie"}
              <span className="muted"> {r ? view.subtasks.filter((s) => s.repo === r).length : view.subtasks.length}</span>
            </button>
          ))}
        </div>
      )}

      <section className="board">
        {COLUMNS.filter((c) => c !== "blocked" || subtasks.some((s) => s.status === "blocked")).map((col) => {
          const items = subtasks.filter((s) => s.status === col);
          return (
            <div key={col} className={`column column-${col}`}>
              <div className="column-head">
                {STATUS_LABEL[col]} <span className="muted">{items.length}</span>
              </div>
              <div className="column-body">
                {items.map((s) => (
                  <Card key={s.id} s={s} all={view.subtasks} showRepo={multiRepo} onOpen={() => setOpenSub(s.id)} onMove={["draft", "todo"].includes(s.status) ? (d) => move(s, d) : undefined} />
                ))}
              </div>
            </div>
          );
        })}
      </section>

      {newSub && <NewSubtaskModal repos={repoNames} onClose={() => setNewSub(false)} onSubmit={addSubtask} />}

      {openSub != null && (
        <SubtaskPanel
          key={openSub}
          subtaskId={openSub}
          all={view.subtasks}
          repos={repoNames}
          onClose={() => setOpenSub(null)}
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
