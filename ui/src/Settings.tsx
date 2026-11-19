import { useEffect, useState } from "react";
import { api, type Project } from "./api";
import { Field, Modal, ResourcesEditor } from "./common";
import { ReposEditor } from "./Repos";

export const PLACEHOLDERS =
  "{{task.key}} {{task.title}} {{task.description}} {{task.ticket_id}} {{task.ticket_url}} {{task.assumptions}} {{task.links}} {{project.name}} {{project.assumptions}} {{resources}} {{subtask.key}} {{subtask.title}} {{subtask.description}} {{subtask.problem}} {{subtask.acceptance}} {{subtask.deps}} {{comments}}";

export function SettingsModal({ onClose, onError, onSaved }: { onClose: () => void; onError: (m: string) => void; onSaved: () => void }) {
  const [s, setS] = useState<Record<string, string> | null>(null);
  const [tab, setTab] = useState<"prompts" | "run" | "resources">("prompts");
  useEffect(() => {
    api.get<Record<string, string>>("/api/settings").then(setS).catch((e) => onError(e.message));
  }, [onError]);
  if (!s) return null;
  const set = (k: string) => (e: { target: { value: string } }) => setS({ ...s, [k]: e.target.value });
  const save = () =>
    api
      .put<Record<string, string>>("/api/settings", s)
      .then((r) => {
        setS(r);
        onSaved();
      })
      .catch((e) => onError(e.message));

  return (
    <Modal title="Ustawienia" onClose={onClose} wide>
      <div className="tabs">
        <button className={tab === "prompts" ? "active" : ""} onClick={() => setTab("prompts")}>
          Prompty domyślne
        </button>
        <button className={tab === "run" ? "active" : ""} onClick={() => setTab("run")}>
          Uruchamianie
        </button>
        <button className={tab === "resources" ? "active" : ""} onClick={() => setTab("resources")}>
          Zasoby globalne
        </button>
      </div>
      {tab === "prompts" && (
        <div className="stack">
          <p className="muted small">Placeholdery: {PLACEHOLDERS}. Każde zadanie może nadpisać prompty.</p>
          <Field label="Prompt planowania (rozbicie na podzadania)">
            <textarea rows={12} className="mono" value={s.plan_prompt} onChange={set("plan_prompt")} />
          </Field>
          <Field label="Prompt implementacji (subagent)">
            <textarea rows={12} className="mono" value={s.impl_prompt} onChange={set("impl_prompt")} />
          </Field>
          <Field label="Prompt sesji review">
            <textarea rows={8} className="mono" value={s.review_prompt} onChange={set("review_prompt")} />
          </Field>
        </div>
      )}
      {tab === "run" && (
        <div className="stack">
          <Field label="Polecenie vk w copy-paste" hint='Np. "vk" (po npm link) albo "node /ścieżka/vibe-kanban/dist/cli.js".'>
            <input className="mono" value={s.cli_command} onChange={set("cli_command")} />
          </Field>
          <Field label="Polecenie Claude Code">
            <input className="mono" value={s.claude_command} onChange={set("claude_command")} />
          </Field>
          <Field label="Tryb uprawnień subagenta (vk run / vk exec)">
            <select value={s.exec_permission_mode} onChange={set("exec_permission_mode")}>
              <option value="default">default</option>
              <option value="acceptEdits">acceptEdits</option>
              <option value="bypassPermissions">bypassPermissions</option>
            </select>
          </Field>
          <Field label="Dozwolone narzędzia subagenta" hint="Oddzielone spacją, składnia --allowedTools Claude Code, np. Bash(npm test:*).">
            <input className="mono" value={s.exec_allowed_tools} onChange={set("exec_allowed_tools")} />
          </Field>
          <Field label="Model subagenta (puste = domyślny)">
            <input className="mono" value={s.exec_model} onChange={set("exec_model")} />
          </Field>
          <Field label="Równoległość (ile podzadań naraz)">
            <input type="number" min={1} max={8} value={s.concurrency} onChange={set("concurrency")} />
          </Field>
        </div>
      )}
      {tab === "resources" && (
        <div className="stack">
          <p className="muted small">
            Zasoby dostępne we wszystkich zadaniach (np. repozytoria wzorcowe organizacji). Zawsze tylko do odczytu. URL git jest klonowany do
            ~/.vk/cache.
          </p>
          <ResourcesEditor scope="global" scopeId={null} onError={onError} />
        </div>
      )}
      {tab !== "resources" && (
        <div className="row-end">
          <button className="btn btn-primary" onClick={save}>
            Zapisz
          </button>
        </div>
      )}
    </Modal>
  );
}

export function ProjectSettings({
  project,
  onClose,
  onError,
  onSaved,
  onDeleted,
}: {
  project: Project;
  onClose: () => void;
  onError: (m: string) => void;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const [p, setP] = useState(project);
  return (
    <Modal title={`Projekt: ${project.name}`} onClose={onClose} wide>
      <div className="stack">
        <Field label="Nazwa">
          <input value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} />
        </Field>
        <Field label="Opis">
          <input value={p.description} onChange={(e) => setP({ ...p, description: e.target.value })} />
        </Field>
        <Field label="Założenia projektu" hint="Trafiają do każdej sesji (planowanie, implementacja, review).">
          <textarea rows={6} value={p.assumptions} onChange={(e) => setP({ ...p, assumptions: e.target.value })} />
        </Field>
        <div className="row-end">
          <button
            className="btn btn-danger btn-ghost"
            onClick={() => {
              if (confirm(`Usunąć projekt ${project.name} z narzędzia? (repozytoria i gałęzie zostają na dysku)`))
                api.del(`/api/projects/${project.id}`).then(onDeleted).catch((e) => onError(e.message));
            }}
          >
            Usuń projekt
          </button>
          <div className="grow" />
          <button
            className="btn btn-primary"
            onClick={() =>
              api
                .put(`/api/projects/${project.id}`, { name: p.name, description: p.description, assumptions: p.assumptions })
                .then(onSaved)
                .catch((e) => onError(e.message))
            }
          >
            Zapisz
          </button>
        </div>
        <h3>Repozytoria</h3>
        <ReposEditor projectId={project.id} repos={project.repos} onChanged={onSaved} onError={onError} />
        <h3>Zasoby referencyjne projektu (tylko do odczytu)</h3>
        <ResourcesEditor scope="project" scopeId={project.id} onError={onError} />
      </div>
    </Modal>
  );
}
