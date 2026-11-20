import { useState } from "react";
import { api, LEVEL_NAME, shortKey, type Item, type Question } from "./api";
import { Modal } from "./common";

const CUSTOM = "__custom__";

/**
 * Pytanie agenta: propozycje odpowiedzi jako radio + „Inna odpowiedź / uwagi” z polem tekstowym
 * (można tam też napisać, że temat trzeba omówić na czacie albo że są dodatkowe pytania).
 */
export function QuestionCard({ q, onChanged, onError }: { q: Question; onChanged: () => void; onError: (m: string) => void }) {
  const [choice, setChoice] = useState<string>(q.options[0] ? "" : CUSTOM);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const name = `q-${q.id}`;

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`question question-${q.status} ${q.blocking && q.status === "open" ? "question-blocking" : ""}`}>
      <div className="question-head">
        <span className="question-text">{q.question}</span>
        {q.blocking && <span className="badge badge-danger">blokujące</span>}
        {q.status === "answered" && <span className="badge badge-ok">odpowiedziano</span>}
        {q.status === "closed" && <span className="badge">zamknięte</span>}
      </div>

      {q.status === "open" ? (
        <form
          className="question-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!choice) return onError("Wybierz odpowiedź");
            if (choice === CUSTOM && !text.trim()) return onError("Wpisz własną odpowiedź");
            act(() => api.post(`/api/questions/${q.id}/answer`, { choice: choice === CUSTOM ? null : choice, text }));
          }}
        >
          {q.options.map((o) => (
            <label key={o} className="radio">
              <input type="radio" name={name} checked={choice === o} onChange={() => setChoice(o)} />
              <span>{o}</span>
            </label>
          ))}
          <label className="radio">
            <input type="radio" name={name} checked={choice === CUSTOM} onChange={() => setChoice(CUSTOM)} />
            <span>Inna odpowiedź / uwagi</span>
          </label>
          <textarea
            rows={2}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              if (e.target.value && !choice) setChoice(CUSTOM);
            }}
            placeholder={
              choice === CUSTOM
                ? "Własna odpowiedź — np. „omówmy to na czacie”, „mam dodatkowe pytania: …”"
                : "Uwagi do wybranej odpowiedzi (opcjonalnie)"
            }
          />
          <div className="row-end">
            <button type="submit" className="btn btn-small btn-primary" disabled={busy}>
              Odpowiedz
            </button>
          </div>
        </form>
      ) : (
        <div className="question-answer">
          {q.status === "answered" && (
            <>
              <div>
                <b>{q.answer_choice ?? "Inna odpowiedź"}</b>
                {q.answer_text && <span className="pre"> — {q.answer_text}</span>}
              </div>
              <button className="btn btn-ghost btn-tiny" disabled={busy} onClick={() => act(() => api.post(`/api/questions/${q.id}/reopen`))}>
                Zmień odpowiedź
              </button>
            </>
          )}
          {q.status === "closed" && q.note && <div className="muted small">Agent: {q.note}</div>}
        </div>
      )}
    </div>
  );
}

/** Wszystkie pytania ticketu w jednym oknie, pogrupowane wg elementu planu. */
export function QuestionsModal({
  taskKey,
  questions,
  items,
  onOpenItem,
  onChanged,
  onError,
  onClose,
}: {
  taskKey: string;
  questions: Question[];
  items: Item[];
  onOpenItem: (id: number) => void;
  onChanged: () => void;
  onError: (m: string) => void;
  onClose: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = questions.filter((q) => showAll || q.status === "open");
  const groups = new Map<string, Question[]>();
  for (const q of visible) groups.set(q.item_key ?? "", [...(groups.get(q.item_key ?? "") ?? []), q]);
  return (
    <Modal title="Pytania agenta" onClose={onClose} wide>
      <label className="row small muted">
        <input type="checkbox" style={{ width: "auto" }} checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
        pokaż też odpowiedziane i zamknięte
      </label>
      {visible.length === 0 && <div className="muted">Brak otwartych pytań.</div>}
      {[...groups.entries()].map(([key, qs]) => {
        const it = items.find((i) => i.key === key);
        return (
          <div key={key || "ticket"} className="stack question-group">
            <div className="field-label">
              {it ? (
                <button className="linklike" onClick={() => onOpenItem(it.id)}>
                  {LEVEL_NAME[it.level]} {shortKey(taskKey, it.key)}: {it.title}
                </button>
              ) : (
                "Cały ticket"
              )}
            </div>
            {qs.map((q) => (
              <QuestionCard key={q.id} q={q} onChanged={onChanged} onError={onError} />
            ))}
          </div>
        );
      })}
    </Modal>
  );
}
