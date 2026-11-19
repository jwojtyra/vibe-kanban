import { useEffect, useState } from "react";
import { api } from "./api";
import { Field, Modal, ResourcesEditor } from "./common";

export const PLACEHOLDERS =
  "{{task.key}} {{task.title}} {{task.description}} {{task.ticket_id}} {{task.ticket_url}} {{task.assumptions}} {{task.links}} {{assumptions}} {{repos}} {{resources}} {{stage.key}} {{stage.title}} {{feature.key}} {{feature.title}} {{feature.description}} {{feature.problem}} {{feature.acceptance}} {{step.key}} {{step.title}} {{step.kind}} {{step.description}} {{step.acceptance}} {{step.repo}} {{step.test_command}} {{comments}}";

type Tab = "assumptions" | "prompts" | "run" | "resources";

export function SettingsModal({ onClose, onError, onSaved }: { onClose: () => void; onError: (m: string) => void; onSaved: () => void }) {
  const [s, setS] = useState<Record<string, string> | null>(null);
  const [tab, setTab] = useState<Tab>("assumptions");
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
  const tabs: [Tab, string][] = [
    ["assumptions", "Założenia"],
    ["prompts", "Prompty domyślne"],
    ["run", "Uruchamianie"],
    ["resources", "Zasoby globalne"],
  ];

  return (
    <Modal title="Ustawienia" onClose={onClose} wide>
      <div className="tabs">
        {tabs.map(([k, label]) => (
          <button key={k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>
      {tab === "assumptions" && (
        <Field label="Założenia globalne" hint="Trafiają do każdej sesji (planowanie, implementacja, review) — np. standardy kodu, konwencje testów.">
          <textarea rows={12} value={s.assumptions} onChange={set("assumptions")} />
        </Field>
      )}
      {tab === "prompts" && (
        <div className="stack">
          <p className="muted small">Placeholdery: {PLACEHOLDERS}. Każdy ticket może nadpisać prompty.</p>
          <Field label="Prompt planowania (Etapy → Funkcje → Kroki)">
            <textarea rows={14} className="mono" value={s.plan_prompt} onChange={set("plan_prompt")} />
          </Field>
          <Field label="Prompt implementacji Kroku (subagent)">
            <textarea rows={14} className="mono" value={s.impl_prompt} onChange={set("impl_prompt")} />
          </Field>
          <Field label="Prompt sesji review Kroku">
            <textarea rows={6} className="mono" value={s.review_prompt} onChange={set("review_prompt")} />
          </Field>
        </div>
      )}
      {tab === "run" && (
        <div className="stack">
          <Field
            label="Polecenie CLI w copy-paste (opcjonalne)"
            hint='Puste (zalecane) = polecenia "bash <(curl …)" generowane przez serwer — nic nie trzeba instalować. Wpisz np. "vk", jeśli używasz CLI po npm link.'
          >
            <input className="mono" value={s.cli_command} onChange={set("cli_command")} />
          </Field>
          <Field label="Polecenie Claude Code">
            <input className="mono" value={s.claude_command} onChange={set("claude_command")} />
          </Field>
          <Field label="Tryb uprawnień subagenta (realizacja Kroków)">
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
          <Field label="Równoległość (ile Kroków naraz)">
            <input type="number" min={1} max={8} value={s.concurrency} onChange={set("concurrency")} />
          </Field>
        </div>
      )}
      {tab === "resources" && (
        <div className="stack">
          <p className="muted small">
            Zasoby dostępne we wszystkich ticketach (np. repozytoria wzorcowe organizacji). Zawsze tylko do odczytu. URL git jest klonowany do ~/.vk/cache.
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
