import { useEffect, useState } from "react";
import { api, type Repo } from "./api";
import { Field, Modal } from "./common";

interface RepoDraft {
  path: string;
  name: string;
  base_branch: string;
  test_command: string;
  description: string;
}

/** Okno dodawania / edycji repozytorium. */
function RepoFormModal({ repo, onClose, onSaved, onError }: { repo: Repo | null; onClose: () => void; onSaved: () => void; onError: (m: string) => void }) {
  const [d, setD] = useState<RepoDraft>({
    path: repo?.path ?? "",
    name: repo?.name ?? "",
    base_branch: repo?.base_branch ?? "",
    test_command: repo?.test_command ?? "",
    description: repo?.description ?? "",
  });
  const set = (k: keyof RepoDraft) => (e: { target: { value: string } }) => setD({ ...d, [k]: e.target.value });
  return (
    <Modal title={repo ? `Repozytorium ${repo.name}` : "Nowe repozytorium"} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          (repo ? api.put(`/api/repos/${repo.id}`, d) : api.post("/api/repos", d))
            .then(() => {
              onSaved();
              onClose();
            })
            .catch((err) => onError(err.message));
        }}
      >
        <Field label="Ścieżka do lokalnego repozytorium git" hint={repo ? "Ścieżki nie można zmienić — usuń i dodaj repozytorium ponownie." : undefined}>
          <input autoFocus={!repo} disabled={!!repo} className="mono" value={d.path} onChange={set("path")} placeholder="~/projects/shop-backend" />
        </Field>
        <Field label="Nazwa" hint="Krótka, np. backend / frontend (domyślnie nazwa katalogu).">
          <input value={d.name} onChange={set("name")} />
        </Field>
        <div className="grid2">
          <Field label="Gałąź bazowa" hint="Domyślnie bieżąca gałąź repo.">
            <input className="mono" value={d.base_branch} onChange={set("base_branch")} placeholder="main" />
          </Field>
          <Field label="Komenda testów" hint="Trafia do kontekstu agenta.">
            <input className="mono" value={d.test_command} onChange={set("test_command")} placeholder="npm test" />
          </Field>
        </div>
        <Field label="Czego dotyczy (opcjonalnie)">
          <input value={d.description} onChange={set("description")} />
        </Field>
        <div className="row-end">
          <button className="btn btn-primary" type="submit">
            {repo ? "Zapisz" : "Dodaj"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Globalna lista repozytoriów. */
export function ReposModal({ onClose, onChanged, onError }: { onClose: () => void; onChanged: () => void; onError: (m: string) => void }) {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [form, setForm] = useState<Repo | "new" | null>(null);
  const load = () =>
    api
      .get<Repo[]>("/api/repos")
      .then(setRepos)
      .catch((e) => onError(e.message));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const changed = () => {
    load();
    onChanged();
  };

  return (
    <Modal title="Repozytoria" onClose={onClose} wide>
      <p className="muted small">Globalna lista lokalnych repozytoriów git. Ticket wskazuje, których dotyczy; każdy Krok planu działa w jednym z nich.</p>
      <div className="repos">
        {repos.length === 0 && <div className="muted small">Brak repozytoriów.</div>}
        {repos.map((r) => (
          <div key={r.id} className="repo-row">
            <span className="tag tag-repo">{r.name}</span>
            <div className="grow">
              <div className="mono small">{r.path}</div>
              <div className="muted small">
                baza <span className="mono">{r.base_branch}</span>
                {r.test_command && (
                  <>
                    {" "}
                    · testy <span className="mono">{r.test_command}</span>
                  </>
                )}
                {r.description && <> · {r.description}</>}
              </div>
            </div>
            <button className="btn btn-ghost btn-small" onClick={() => setForm(r)}>
              Edytuj
            </button>
            <button
              className="btn btn-ghost btn-small btn-danger"
              onClick={() => {
                if (confirm(`Usunąć ${r.name} z listy? (pliki i gałęzie zostają na dysku)`)) api.del(`/api/repos/${r.id}`).then(changed).catch((err) => onError(err.message));
              }}
            >
              Usuń
            </button>
          </div>
        ))}
        <button className="btn btn-small btn-primary align-start" onClick={() => setForm("new")}>
          + Dodaj repozytorium
        </button>
      </div>
      {form && <RepoFormModal repo={form === "new" ? null : form} onClose={() => setForm(null)} onSaved={changed} onError={onError} />}
    </Modal>
  );
}

/** Wybór repozytoriów (chipy). */
export function RepoPicker({ all, selected, onToggle }: { all: Repo[]; selected: string[]; onToggle: (name: string, on: boolean) => void }) {
  if (all.length === 0) return <div className="muted small">Brak repozytoriów — dodaj je w „Repozytoria” na górnym pasku.</div>;
  return (
    <div className="repo-picker">
      {all.map((r) => {
        const on = selected.includes(r.name);
        return (
          <button type="button" key={r.id} className={`chip ${on ? "active" : ""}`} title={r.path} onClick={() => onToggle(r.name, !on)}>
            {on ? "✓ " : ""}
            {r.name}
          </button>
        );
      })}
    </div>
  );
}
