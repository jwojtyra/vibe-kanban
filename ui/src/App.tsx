import { useCallback, useEffect, useState } from "react";
import { api, type Project, type Task } from "./api";
import { Field, Modal, useToast } from "./common";
import { ProjectSettings, SettingsModal } from "./Settings";
import { TaskPage } from "./TaskPage";

function NewProjectModal({ onClose, onCreated, onError }: { onClose: () => void; onCreated: (p: Project) => void; onError: (m: string) => void }) {
  const [repo, setRepo] = useState("");
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("");
  return (
    <Modal title="Nowy projekt" onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          api
            .post<Project>("/api/projects", { repo_path: repo, name, base_branch: branch })
            .then(onCreated)
            .catch((e) => onError(e.message));
        }}
      >
        <Field label="Ścieżka do lokalnego repozytorium git">
          <input autoFocus value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="/home/ja/projekty/moja-aplikacja" />
        </Field>
        <Field label="Nazwa (opcjonalnie)">
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Gałąź bazowa" hint="Domyślnie bieżąca gałąź repozytorium.">
          <input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" />
        </Field>
        <div className="row-end">
          <button className="btn btn-primary" type="submit">
            Dodaj projekt
          </button>
        </div>
      </form>
    </Modal>
  );
}

function NewTaskModal({ project, onClose, onCreated, onError }: { project: Project; onClose: () => void; onCreated: (id: number) => void; onError: (m: string) => void }) {
  const [fromTicket, setFromTicket] = useState(true);
  const [ticketUrl, setTicketUrl] = useState("");
  const [ticketId, setTicketId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  useEffect(() => {
    if (!ticketUrl) return setTicketId("");
    const t = setTimeout(() => {
      api.get<{ ticket_id: string }>(`/api/ticket-id?url=${encodeURIComponent(ticketUrl)}`).then((r) => setTicketId(r.ticket_id));
    }, 200);
    return () => clearTimeout(t);
  }, [ticketUrl]);
  return (
    <Modal title="Nowe zadanie" onClose={onClose}>
      <div className="segmented">
        <button className={fromTicket ? "active" : ""} onClick={() => setFromTicket(true)}>
          Z ticketu
        </button>
        <button className={!fromTicket ? "active" : ""} onClick={() => setFromTicket(false)}>
          Puste
        </button>
      </div>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          api
            .post<{ task: Task }>(`/api/projects/${project.id}/tasks`, {
              title,
              description,
              ticket_url: fromTicket ? ticketUrl : "",
            })
            .then((r) => onCreated(r.task.id))
            .catch((e) => onError(e.message));
        }}
      >
        {fromTicket && (
          <Field label="Link do ticketu (Jira, GitHub, GitLab…)" hint={ticketId ? `ID ticketu: ${ticketId} — będzie kluczem zadania` : "Wklej link — ID zostanie wyciągnięte automatycznie."}>
            <input autoFocus value={ticketUrl} onChange={(e) => setTicketUrl(e.target.value)} placeholder="https://firma.atlassian.net/browse/PROJ-123" />
          </Field>
        )}
        <Field label="Tytuł">
          <input autoFocus={!fromTicket} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={ticketId || "Co ma zostać zrobione"} />
        </Field>
        <Field label="Opis (opcjonalnie — możesz uzupełnić później)">
          <textarea rows={5} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="row-end">
          <button className="btn btn-primary" type="submit">
            Utwórz zadanie
          </button>
        </div>
      </form>
    </Modal>
  );
}

const STORAGE = "vk.selection";

export function App() {
  const toast = useToast();
  const showToast = toast.show;
  const onError = useCallback((m: string) => showToast(m, true), [showToast]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<number | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [taskId, setTaskId] = useState<number | null>(null);
  const [modal, setModal] = useState<"project" | "task" | "settings" | "projectSettings" | null>(null);

  const project = projects.find((p) => p.id === projectId) ?? null;

  const loadProjects = () =>
    api.get<Project[]>("/api/projects").then((ps) => {
      setProjects(ps);
      let saved: { projectId?: number; taskId?: number } = {};
      try {
        saved = JSON.parse(localStorage.getItem(STORAGE) ?? "{}");
      } catch {
        /* brak */
      }
      setProjectId((cur) => cur ?? (ps.find((p) => p.id === saved.projectId)?.id ?? ps[0]?.id ?? null));
      setTaskId((cur) => cur ?? saved.taskId ?? null);
    });
  const loadTasks = useCallback(() => {
    if (projectId == null) return setTasks([]);
    api.get<Task[]>(`/api/projects/${projectId}/tasks`).then(setTasks).catch((e) => onError(e.message));
  }, [projectId, onError]);

  useEffect(() => {
    loadProjects().catch((e) => onError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    loadTasks();
    const t = setInterval(loadTasks, 5000);
    return () => clearInterval(t);
  }, [loadTasks]);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE, JSON.stringify({ projectId, taskId }));
    } catch {
      /* brak */
    }
  }, [projectId, taskId]);

  const taskInProject = tasks.some((t) => t.id === taskId);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">vibe-kanban</div>
        <select
          value={projectId ?? ""}
          onChange={(e) => {
            setProjectId(Number(e.target.value));
            setTaskId(null);
          }}
        >
          {projects.length === 0 && <option value="">— brak projektów —</option>}
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button className="btn btn-small" onClick={() => setModal("project")}>
          + Projekt
        </button>
        {project && (
          <button className="btn btn-small btn-ghost" onClick={() => setModal("projectSettings")}>
            Ustawienia projektu
          </button>
        )}
        <div className="grow" />
        <button className="btn btn-small btn-ghost" onClick={() => setModal("settings")}>
          Ustawienia
        </button>
      </header>

      <div className="layout">
        <aside className="sidebar">
          <div className="sidebar-head">
            <span>Zadania</span>
            {project && (
              <button className="btn btn-small btn-primary" onClick={() => setModal("task")}>
                + Zadanie
              </button>
            )}
          </div>
          {!project && <div className="muted small pad">Dodaj projekt (lokalne repozytorium git), aby zacząć.</div>}
          {tasks.map((t) => {
            const subs = t.subtasks ?? [];
            const done = subs.filter((s) => s.status === "done").length;
            const review = subs.filter((s) => s.status === "review").length;
            return (
              <button key={t.id} className={`task-item ${t.id === taskId ? "active" : ""}`} onClick={() => setTaskId(t.id)}>
                <div className="task-item-key mono">{t.key}</div>
                <div className="task-item-title">{t.title}</div>
                <div className="muted small">
                  {subs.length ? `${done}/${subs.length} done` : "bez podzadań"}
                  {review ? ` · ${review} w review` : ""}
                </div>
              </button>
            );
          })}
        </aside>
        <main className="main">
          {project && taskId != null && taskInProject ? (
            <TaskPage key={taskId} taskId={taskId} onError={onError} onToast={(m) => toast.show(m)} onChanged={loadTasks} onDeleted={() => (setTaskId(null), loadTasks())} />
          ) : (
            <div className="empty">
              <h2>Lokalny kanban dla Claude Code</h2>
              <ol>
                <li>Dodaj projekt (lokalne repo git) i zadanie — np. z linku do ticketu.</li>
                <li>Uzupełnij linki, założenia, zasoby referencyjne i ewentualnie prompty.</li>
                <li>Skopiuj polecenie planowania do terminala — Claude rozbije zadanie na podzadania.</li>
                <li>Zaakceptuj plan, uruchom realizację, a potem przeglądaj i komentuj w Review.</li>
              </ol>
              <p className="muted small">Ta strona nigdy nie wysyła niczego do Claude — pracę wykonują sesje uruchamiane z terminala.</p>
            </div>
          )}
        </main>
      </div>

      {modal === "project" && (
        <NewProjectModal
          onClose={() => setModal(null)}
          onError={onError}
          onCreated={(p) => {
            setModal(null);
            loadProjects();
            setProjectId(p.id);
            setTaskId(null);
          }}
        />
      )}
      {modal === "task" && project && (
        <NewTaskModal
          project={project}
          onClose={() => setModal(null)}
          onError={onError}
          onCreated={(id) => {
            setModal(null);
            loadTasks();
            setTaskId(id);
          }}
        />
      )}
      {modal === "settings" && <SettingsModal onClose={() => setModal(null)} onError={onError} onSaved={() => toast.show("Zapisano ustawienia")} />}
      {modal === "projectSettings" && project && (
        <ProjectSettings
          project={project}
          onClose={() => setModal(null)}
          onError={onError}
          onSaved={() => {
            loadProjects();
            toast.show("Zapisano projekt");
          }}
          onDeleted={() => {
            setModal(null);
            setProjectId(null);
            setTaskId(null);
            loadProjects();
          }}
        />
      )}
      {toast.node}
    </div>
  );
}
