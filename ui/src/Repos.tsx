import { useState } from "react";
import { api, type Repo } from "./api";

export interface RepoDraft {
  path: string;
  name: string;
  base_branch: string;
  description: string;
}

export const emptyRepo = (): RepoDraft => ({ path: "", name: "", base_branch: "", description: "" });

/** Wiersze do wpisania repozytoriów (formularz nowego projektu). */
export function RepoDraftRows({ rows, onChange }: { rows: RepoDraft[]; onChange: (r: RepoDraft[]) => void }) {
  const set = (i: number, patch: Partial<RepoDraft>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="repos">
      {rows.map((r, i) => (
        <div key={i} className="repo-draft">
          <input className="grow mono" placeholder="Ścieżka do repo, np. ~/projects/shop-frontend" value={r.path} onChange={(e) => set(i, { path: e.target.value })} />
          <input placeholder="Nazwa (np. frontend)" value={r.name} onChange={(e) => set(i, { name: e.target.value })} />
          <input placeholder="Gałąź bazowa (domyślnie bieżąca)" value={r.base_branch} onChange={(e) => set(i, { base_branch: e.target.value })} />
          <input className="grow" placeholder="Czego dotyczy (opcjonalnie)" value={r.description} onChange={(e) => set(i, { description: e.target.value })} />
          {rows.length > 1 && (
            <button type="button" className="btn btn-ghost btn-small" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
              Usuń
            </button>
          )}
        </div>
      ))}
      <button type="button" className="btn btn-small align-start" onClick={() => onChange([...rows, emptyRepo()])}>
        + Kolejne repozytorium
      </button>
    </div>
  );
}

/** Lista repozytoriów istniejącego projektu z edycją, usuwaniem i dodawaniem. */
export function ReposEditor({ projectId, repos, onChanged, onError }: { projectId: number; repos: Repo[]; onChanged: () => void; onError: (m: string) => void }) {
  const [draft, setDraft] = useState<RepoDraft>(emptyRepo());
  const [edit, setEdit] = useState<Record<number, Partial<Repo>>>({});
  return (
    <div className="repos">
      {repos.length === 0 && <div className="muted small">Projekt nie ma jeszcze repozytoriów.</div>}
      {repos.map((r) => {
        const e = edit[r.id];
        return (
          <div key={r.id} className="repo-row">
            <span className="tag tag-repo">{r.name}</span>
            <div className="grow">
              <div className="mono small">{r.path}</div>
              {e ? (
                <div className="repo-edit">
                  <input value={e.base_branch ?? r.base_branch} onChange={(ev) => setEdit({ ...edit, [r.id]: { ...e, base_branch: ev.target.value } })} placeholder="Gałąź bazowa" />
                  <input className="grow" value={e.description ?? r.description} onChange={(ev) => setEdit({ ...edit, [r.id]: { ...e, description: ev.target.value } })} placeholder="Czego dotyczy" />
                  <button
                    className="btn btn-small btn-primary"
                    onClick={() =>
                      api
                        .put(`/api/repos/${r.id}`, e)
                        .then(() => {
                          const { [r.id]: _, ...rest } = edit;
                          setEdit(rest);
                          onChanged();
                        })
                        .catch((err) => onError(err.message))
                    }
                  >
                    Zapisz
                  </button>
                </div>
              ) : (
                <div className="muted small">
                  baza <span className="mono">{r.base_branch}</span>
                  {r.description && <> · {r.description}</>}
                </div>
              )}
            </div>
            {!e && (
              <button className="btn btn-ghost btn-small" onClick={() => setEdit({ ...edit, [r.id]: {} })}>
                Edytuj
              </button>
            )}
            <button
              className="btn btn-ghost btn-small btn-danger"
              onClick={() => {
                if (confirm(`Usunąć repozytorium ${r.name} z projektu? (pliki i gałęzie zostają na dysku)`))
                  api.del(`/api/repos/${r.id}`).then(onChanged).catch((err) => onError(err.message));
              }}
            >
              Usuń
            </button>
          </div>
        );
      })}
      <form
        className="repo-draft"
        onSubmit={(ev) => {
          ev.preventDefault();
          if (!draft.path.trim()) return;
          api
            .post(`/api/projects/${projectId}/repos`, draft)
            .then(() => {
              setDraft(emptyRepo());
              onChanged();
            })
            .catch((err) => onError(err.message));
        }}
      >
        <input className="grow mono" placeholder="Ścieżka do repo" value={draft.path} onChange={(e) => setDraft({ ...draft, path: e.target.value })} />
        <input placeholder="Nazwa (np. backend)" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        <input placeholder="Gałąź bazowa" value={draft.base_branch} onChange={(e) => setDraft({ ...draft, base_branch: e.target.value })} />
        <input className="grow" placeholder="Czego dotyczy" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
        <button className="btn btn-small" type="submit">
          Dodaj repo
        </button>
      </form>
    </div>
  );
}
