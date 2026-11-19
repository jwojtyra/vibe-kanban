import { useCallback, useEffect, useState } from "react";
import { api, type Repo, type Task, type TaskView } from "./api";
import { Field, Modal, useToast } from "./common";
import { RepoPicker, ReposModal } from "./Repos";
import { SettingsModal } from "./Settings";
import { TaskPage } from "./TaskPage";

function NewTaskModal({
  repos,
  onClose,
  onCreated,
  onOpenRepos,
  onError,
}: {
  repos: Repo[];
  onClose: () => void;
  onCreated: (id: number) => void;
  onOpenRepos: () => void;
  onError: (m: string) => void;
}) {
  const [ticketUrl, setTicketUrl] = useState("");
  const [ticketId, setTicketId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  useEffect(() => {
    if (!ticketUrl) return setTicketId("");
    const t = setTimeout(() => {
      api.get<{ ticket_id: string }>(`/api/ticket-id?url=${encodeURIComponent(ticketUrl)}`).then((r) => setTicketId(r.ticket_id));
    }, 200);
    return () => clearTimeout(t);
  }, [ticketUrl]);
  return (
    <Modal title="Nowy ticket" onClose={onClose} wide>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          api
            .post<TaskView>("/api/tasks", { title, description, ticket_url: ticketUrl, repos: selected })
            .then((r) => onCreated(r.task.id))
            .catch((err) => onError(err.message));
        }}
      >
        <Field label="Link do ticketu (Jira, GitHub, GitLab…) — opcjonalnie" hint={ticketId ? `ID ticketu: ${ticketId} — będzie kluczem` : "Wklej link — ID zostanie wyciągnięte automatycznie."}>
          <input autoFocus value={ticketUrl} onChange={(e) => setTicketUrl(e.target.value)} placeholder="https://firma.atlassian.net/browse/PROJ-123" />
        </Field>
        <Field label="Tytuł">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={ticketId || "Co ma zostać zrobione"} />
        </Field>
        <Field label="Opis (opcjonalnie — możesz uzupełnić później)">
          <textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="field">
          <span className="field-label">Repozytoria, których dotyczy ticket</span>
          <RepoPicker all={repos} selected={selected} onToggle={(n, on) => setSelected(on ? [...selected, n] : selected.filter((x) => x !== n))} />
          <button type="button" className="btn btn-ghost btn-small align-start" onClick={onOpenRepos}>
            + Dodaj repozytorium do listy
          </button>
        </div>
        <div className="row-end">
          <button className="btn btn-primary" type="submit">
            Utwórz ticket
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
  const [repos, setRepos] = useState<Repo[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [taskId, setTaskId] = useState<number | null>(() => {
    try {
      return JSON.parse(localStorage.getItem(STORAGE) ?? "{}").taskId ?? null;
    } catch {
      return null;
    }
  });
  const [modal, setModal] = useState<"task" | "settings" | "repos" | null>(null);
  const [reposReturn, setReposReturn] = useState(false);

  const loadRepos = useCallback(() => api.get<Repo[]>("/api/repos").then(setRepos).catch((e) => onError(e.message)), [onError]);
  const loadTasks = useCallback(() => api.get<Task[]>("/api/tasks").then(setTasks).catch((e) => onError(e.message)), [onError]);

  useEffect(() => {
    loadRepos();
    loadTasks();
    const t = setInterval(loadTasks, 5000);
    return () => clearInterval(t);
  }, [loadRepos, loadTasks]);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE, JSON.stringify({ taskId }));
    } catch {
      /* brak */
    }
  }, [taskId]);

  const taskExists = tasks.some((t) => t.id === taskId);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">vibe-kanban</div>
        <div className="grow" />
        <button className="btn btn-small btn-ghost" onClick={() => setModal("repos")}>
          Repozytoria ({repos.length})
        </button>
        <button className="btn btn-small btn-ghost" onClick={() => setModal("settings")}>
          Ustawienia
        </button>
      </header>

      <div className="layout">
        <aside className="sidebar">
          <div className="sidebar-head">
            <span>Tickety</span>
            <button className="btn btn-small btn-primary" onClick={() => setModal("task")}>
              + Ticket
            </button>
          </div>
          {tasks.length === 0 && <div className="muted small pad">Brak ticketów.</div>}
          {tasks.map((t) => {
            const steps = t.steps ?? [];
            const done = steps.filter((s) => s.status === "done").length;
            const review = steps.filter((s) => s.status === "review").length;
            return (
              <button key={t.id} className={`task-item ${t.id === taskId ? "active" : ""}`} onClick={() => setTaskId(t.id)}>
                <div className="task-item-key mono">{t.key}</div>
                <div className="task-item-title">{t.title}</div>
                <div className="muted small">
                  {steps.length ? `${done}/${steps.length} kroków done` : "bez planu"}
                  {review ? ` · ${review} w review` : ""}
                </div>
                {t.repos && t.repos.length > 0 && (
                  <div className="task-item-repos">
                    {t.repos.map((r) => (
                      <span key={r} className="tag tag-repo">
                        {r}
                      </span>
                    ))}
                  </div>
                )}
              </button>
            );
          })}
        </aside>
        <main className="main">
          {taskId != null && taskExists ? (
            <TaskPage
              key={taskId}
              taskId={taskId}
              allRepos={repos}
              onError={onError}
              onToast={(m) => toast.show(m)}
              onChanged={loadTasks}
              onOpenRepos={() => setModal("repos")}
              onDeleted={() => {
                setTaskId(null);
                loadTasks();
              }}
            />
          ) : (
            <div className="empty">
              <h2>Lokalny kanban dla Claude Code</h2>
              <ol>
                <li>Dodaj repozytoria (górny pasek → Repozytoria) i utwórz ticket — np. z linku do Jiry — wskazując repo, których dotyczy.</li>
                <li>Uzupełnij linki, założenia, zasoby referencyjne i ewentualnie prompty.</li>
                <li>
                  Skopiuj polecenie planowania do terminala — Claude rozbije ticket na <b>Etapy</b> → <b>Funkcje</b> (zmiana zachowania + testy akceptacyjne) →{" "}
                  <b>Kroki</b> (najmniejsze klocki; najpierw czerwone testy, potem implementacja).
                </li>
                <li>Zaakceptuj plan, uruchom realizację, a potem przeglądaj i komentuj Kroki w Review.</li>
              </ol>
              <p className="muted small">Ta strona nigdy nie wysyła niczego do Claude — pracę wykonują sesje uruchamiane z terminala.</p>
            </div>
          )}
        </main>
      </div>

      {modal === "task" && (
        <NewTaskModal
          repos={repos}
          onClose={() => setModal(null)}
          onError={onError}
          onOpenRepos={() => {
            setReposReturn(true);
            setModal("repos");
          }}
          onCreated={(id) => {
            setModal(null);
            loadTasks();
            setTaskId(id);
          }}
        />
      )}
      {modal === "repos" && (
        <ReposModal
          onClose={() => {
            setModal(reposReturn ? "task" : null);
            setReposReturn(false);
          }}
          onChanged={loadRepos}
          onError={onError}
        />
      )}
      {modal === "settings" && <SettingsModal onClose={() => setModal(null)} onError={onError} onSaved={() => toast.show("Zapisano ustawienia")} />}
      {toast.node}
    </div>
  );
}
