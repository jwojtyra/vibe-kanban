import { useEffect, useState } from "react";
import { api } from "./api";
import { clip, EditTile, Field, Modal, ResourcesEditor, TextModal } from "./common";

export const PLACEHOLDERS =
  "{{task.key}} {{task.title}} {{task.description}} {{task.ticket_id}} {{task.ticket_url}} {{task.assumptions}} {{task.links}} {{guidelines}} {{levels}} {{level.stage}} {{level.feature}} {{level.step}} {{questions}} {{repos}} {{resources}} {{stage.key}} {{stage.title}} {{feature.key}} {{feature.title}} {{feature.description}} {{feature.problem}} {{feature.acceptance}} {{step.key}} {{step.title}} {{step.kind}} {{step.description}} {{step.acceptance}} {{step.repo}} {{step.test_command}} {{comments}}";

type Settings = Record<string, string>;

const PROMPTS: [string, string, string][] = [
  ["plan_prompt", "Prompt planowania", "Startowa wiadomość sesji planowania ticketu (Etapy → Funkcje → Kroki)."],
  ["impl_prompt", "Prompt implementacji Kroku", "Zadanie dla subagenta wykonującego Krok."],
  ["review_prompt", "Prompt sesji review Kroku", "Startowa wiadomość sesji pracy nad komentarzami z review."],
];

const LEVELS: [string, string, string][] = [
  ["level_stage", "Etap (poziom 1)", "Jak definiować Etapy — gruby podział pracy."],
  ["level_feature", "Funkcja (poziom 2)", "Jak definiować Funkcje — zmiana zachowania/API i testy akceptacyjne."],
  ["level_step", "Krok (poziom 3)", "Jak definiować Kroki — najmniejsze klocki, test-first."],
];

function useSettings(onError: (m: string) => void) {
  const [s, setS] = useState<Settings | null>(null);
  useEffect(() => {
    api.get<Settings>("/api/settings").then(setS).catch((e) => onError(e.message));
  }, [onError]);
  const save = (patch: Settings) =>
    api
      .put<Settings>("/api/settings", patch)
      .then(setS)
      .catch((e) => {
        onError(e.message);
        throw e;
      });
  return { s, save };
}

function RunSettingsModal({ s, onSave, onClose }: { s: Settings; onSave: (p: Settings) => Promise<unknown>; onClose: () => void }) {
  const [v, setV] = useState(s);
  const set = (k: string) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value });
  return (
    <Modal title="Uruchamianie sesji" onClose={onClose} wide>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          const keys = ["cli_command", "claude_command", "exec_permission_mode", "exec_allowed_tools", "exec_model", "concurrency"];
          onSave(Object.fromEntries(keys.map((k) => [k, v[k]]))).then(onClose);
        }}
      >
        <Field label="Polecenie Claude Code">
          <input className="mono" value={v.claude_command} onChange={set("claude_command")} />
        </Field>
        <Field label="Tryb uprawnień subagenta (realizacja Kroków)">
          <select value={v.exec_permission_mode} onChange={set("exec_permission_mode")}>
            <option value="default">default</option>
            <option value="acceptEdits">acceptEdits</option>
            <option value="bypassPermissions">bypassPermissions</option>
          </select>
        </Field>
        <Field label="Dozwolone narzędzia subagenta" hint="Oddzielone spacją, składnia --allowedTools Claude Code, np. Bash(npm test:*).">
          <input className="mono" value={v.exec_allowed_tools} onChange={set("exec_allowed_tools")} />
        </Field>
        <Field label="Model subagenta (puste = domyślny)">
          <input className="mono" value={v.exec_model} onChange={set("exec_model")} />
        </Field>
        <Field label="Równoległość (ile Kroków naraz, tylko CLI vk)">
          <input type="number" min={1} max={8} value={v.concurrency} onChange={set("concurrency")} />
        </Field>
        <Field
          label="Polecenie CLI w copy-paste (opcjonalne)"
          hint='Puste (zalecane) = polecenia "bash <(curl …)" generowane przez serwer. Wpisz np. "vk", jeśli używasz CLI po npm link.'
        >
          <input className="mono" value={v.cli_command} onChange={set("cli_command")} />
        </Field>
        <div className="row-end">
          <button type="submit" className="btn btn-primary">
            Zapisz
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function SettingsModal({ onClose, onError, onSaved }: { onClose: () => void; onError: (m: string) => void; onSaved: () => void }) {
  const { s, save } = useSettings(onError);
  const [edit, setEdit] = useState<string | null>(null);
  const [resCount, setResCount] = useState(0);
  const [showRes, setShowRes] = useState(false);
  if (!s) return null;
  const saveAnd = (p: Settings) => save(p).then(onSaved);
  const all = [...PROMPTS, ...LEVELS];
  const cur = all.find(([k]) => k === edit);

  return (
    <Modal title="Ustawienia" onClose={onClose} wide>
      <h3>Prompty sesji</h3>
      <div className="tiles">
        {PROMPTS.map(([k, label]) => (
          <EditTile key={k} label={label} filled={!!s[k]?.trim()} summary={clip(s[k] ?? "")} onClick={() => setEdit(k)} />
        ))}
      </div>
      <h3>Prompty poziomów planu</h3>
      <p className="muted small">Ogólne zasady dla każdego poziomu — trafiają do sesji planowania i sesji Kroków.</p>
      <div className="tiles">
        {LEVELS.map(([k, label]) => (
          <EditTile key={k} label={label} filled={!!s[k]?.trim()} summary={clip(s[k] ?? "")} onClick={() => setEdit(k)} />
        ))}
      </div>
      <h3>Uruchamianie</h3>
      <div className="tiles">
        <EditTile
          label="Claude Code i subagenci"
          filled
          summary={`${s.claude_command} · uprawnienia: ${s.exec_permission_mode}${s.exec_model ? ` · model: ${s.exec_model}` : ""}`}
          onClick={() => setEdit("run")}
        />
      </div>
      <h3>Zasoby globalne</h3>
      <div className="tiles">
        <EditTile
          label="Zasoby referencyjne (tylko do odczytu)"
          filled={resCount > 0}
          summary={`${resCount} zasob(y/ów) dostępnych we wszystkich ticketach`}
          onClick={() => setShowRes(true)}
        />
      </div>
      {/* licznik zasobów bez pokazywania formularza */}
      <div style={{ display: "none" }}>
        <ResourcesEditor scope="global" scopeId={null} onError={onError} onChanged={setResCount} />
      </div>

      {cur && (
        <TextModal
          title={cur[1]}
          value={s[cur[0]] ?? ""}
          mono
          rows={18}
          hint={
            <>
              {cur[2]} Placeholdery: {PLACEHOLDERS}
            </>
          }
          resetLabel="Przywróć domyślny"
          onReset={() => saveAnd({ [cur[0]]: "" }).then(() => api.get<Settings>("/api/settings")).then(() => setEdit(null))}
          onSave={(v) => saveAnd({ [cur[0]]: v })}
          onClose={() => setEdit(null)}
        />
      )}
      {edit === "run" && <RunSettingsModal s={s} onSave={saveAnd} onClose={() => setEdit(null)} />}
      {showRes && (
        <Modal title="Zasoby globalne" onClose={() => setShowRes(false)} wide>
          <p className="muted small">Np. repozytoria wzorcowe organizacji. Zawsze tylko do odczytu. URL git jest klonowany do ~/.vk/cache.</p>
          <ResourcesEditor scope="global" scopeId={null} onError={onError} onChanged={setResCount} />
        </Modal>
      )}
    </Modal>
  );
}

/** Dokument „Wytyczne”: wymagania techniczne zbierane na bieżąco (trafia do każdej sesji). */
export function GuidelinesModal({ onClose, onError, onSaved }: { onClose: () => void; onError: (m: string) => void; onSaved: () => void }) {
  const { s, save } = useSettings(onError);
  if (!s) return null;
  return (
    <TextModal
      title="Wytyczne"
      value={s.guidelines || s.assumptions || ""}
      mono
      rows={24}
      hint={
        <>
          Twoje wymagania techniczne — jak pisać kod, klasy, testy, czego nie robić. Trafiają do każdej sesji (planowanie, Kroki, review). Markdown,
          np. sekcje <code>## Testy</code>, <code>## Klasy</code>. Agent może dopisywać zasady, gdy go o to poprosisz („zapisz w wytycznych, że…”).
        </>
      }
      placeholder={"## Ogólne\n- …\n\n## Testy\n- …\n\n## Czego nie robić\n- …"}
      onSave={(v) => save({ guidelines: v, assumptions: "" }).then(onSaved)}
      onClose={onClose}
    />
  );
}
