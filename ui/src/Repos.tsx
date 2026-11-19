import { useEffect, useState } from "react";
import { api, type Repo } from "./api";
import { Modal } from "./common";

interface RepoDraft {
  path: string;
  name: string;
  base_branch: string;
  test_command: string;
  description: string;
}

const emptyRepo = (): RepoDraft => ({ path: "", name: "", base_branch: "", test_command: "", description: "" });

/** Globalna lista repozytoriów (dodawanie, edycja, usuwanie). */
export function ReposModal({ onClose, onChanged, onError }: { onClose: () => void; onChanged: () => void; onError: (m: string) => void }) {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [draft, setDraft] = useState<RepoDraft>(emptyRepo());
  const [edit, setEdit] = useState<Record<number, Partial<Repo>>>({});
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
      <p className="muted small">
        Globalna lista lokalnych repozytoriów git. Ticket wskazuje, których dotyczy; każdy Krok planu działa w jednym z nich. Komenda testów trafia
        do kontekstu agenta.
      </p>
      <div className="repos">
        {repos.length === 0 && <div className="muted small">Brak repozytoriów.</div>}
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
                    <input className="mono" value={e.test_command ?? r.test_command} onChange={(ev) => setEdit({ ...edit, [r.id]: { ...e, test_command: ev.target.value } })} placeholder="Komenda testów" />
                    <input className="grow" value={e.description ?? r.description} onChange={(ev) => setEdit({ ...edit, [r.id]: { ...e, description: ev.target.value } })} placeholder="Czego dotyczy" />
                    <button
                      className="btn btn-small btn-primary"
                      onClick={() =>
                        api
                          .put(`/api/repos/${r.id}`, e)
                          .then(() => {
                            const { [r.id]: _, ...rest } = edit;
                            setEdit(rest);
                            changed();
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
                    {r.test_command && (
                      <>
                        {" "}
                        · testy <span className="mono">{r.test_command}</span>
                      </>
                    )}
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
                  if (confirm(`Usunąć ${r.name} z listy? (pliki i gałęzie zostają na dysku)`))
                    api.del(`/api/repos/${r.id}`).then(changed).catch((err) => onError(err.message));
                }}
              >
                Usuń
              </button>
            </div>
          );
        })}
      </div>
      <form
        className="repo-add"
        onSubmit={(ev) => {
          ev.preventDefault();
          if (!draft.path.trim()) return;
          api
            .post("/api/repos", draft)
            .then(() => {
              setDraft(emptyRepo());
              changed();
            })
            .catch((err) => onError(err.message));
        }}
      >
        <div className="field-label">Dodaj repozytorium</div>
        <div className="repo-draft">
          <input className="grow mono" placeholder="Ścieżka, np. ~/projects/shop-backend" value={draft.path} onChange={(e) => setDraft({ ...draft, path: e.target.value })} />
          <input placeholder="Nazwa (np. backend)" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <input placeholder="Gałąź bazowa (domyślnie bieżąca)" value={draft.base_branch} onChange={(e) => setDraft({ ...draft, base_branch: e.target.value })} />
        </div>
        <div className="repo-draft">
          <input className="mono" placeholder="Komenda testów (np. npm test)" value={draft.test_command} onChange={(e) => setDraft({ ...draft, test_command: e.target.value })} />
          <input className="grow" placeholder="Czego dotyczy (opcjonalnie)" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          <button className="btn btn-small btn-primary" type="submit">
            Dodaj
          </button>
        </div>
      </form>
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
