import { Fragment, useMemo, useState } from "react";
import type { Comment } from "./api";

interface DiffLine {
  type: "ctx" | "add" | "del" | "hunk" | "meta";
  text: string;
  oldNo?: number;
  newNo?: number;
}

interface DiffFile {
  path: string;
  oldPath: string;
  status: string;
  lines: DiffLine[];
  adds: number;
  dels: number;
}

export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let oldNo = 0;
  let newNo = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      const m = raw.match(/^diff --git a\/(.*) b\/(.*)$/);
      cur = { path: m?.[2] ?? raw, oldPath: m?.[1] ?? "", status: "zmieniony", lines: [], adds: 0, dels: 0 };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (raw.startsWith("@@")) {
      const m = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      oldNo = Number(m?.[1] ?? 0);
      newNo = Number(m?.[2] ?? 0);
      cur.lines.push({ type: "hunk", text: raw });
      continue;
    }
    if (raw.startsWith("+++ ")) {
      if (raw !== "+++ /dev/null") cur.path = raw.slice(4).replace(/^b\//, "");
      continue;
    }
    if (raw.startsWith("--- ")) {
      if (raw === "--- /dev/null") cur.status = "nowy";
      continue;
    }
    if (raw.startsWith("new file")) {
      cur.status = "nowy";
      continue;
    }
    if (raw.startsWith("deleted file")) {
      cur.status = "usunięty";
      continue;
    }
    if (raw.startsWith("rename from") || raw.startsWith("similarity") || raw.startsWith("rename to")) {
      cur.status = "przeniesiony";
      continue;
    }
    if (raw.startsWith("index ") || raw.startsWith("old mode") || raw.startsWith("new mode") || raw.startsWith("Binary")) {
      if (raw.startsWith("Binary")) cur.lines.push({ type: "meta", text: "Plik binarny" });
      continue;
    }
    const c = raw[0];
    if (c === "+") {
      cur.lines.push({ type: "add", text: raw.slice(1), newNo: newNo++ });
      cur.adds++;
    } else if (c === "-") {
      cur.lines.push({ type: "del", text: raw.slice(1), oldNo: oldNo++ });
      cur.dels++;
    } else if (c === " ") {
      cur.lines.push({ type: "ctx", text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ });
    } else if (c === "\\") {
      cur.lines.push({ type: "meta", text: raw });
    }
  }
  return files;
}

function lineKey(file: string, side: string, line: number) {
  return `${file}|${side}|${line}`;
}

export function DiffView({
  diff,
  comments,
  onAddComment,
  onResolve,
  onDelete,
}: {
  diff: string;
  comments: Comment[];
  onAddComment: (c: { file: string; line: number; side: string; line_text: string; body: string }) => Promise<void>;
  onResolve: (c: Comment) => void;
  onDelete: (c: Comment) => void;
}) {
  const files = useMemo(() => parseDiff(diff), [diff]);
  const [draft, setDraft] = useState<{ key: string; file: string; line: number; side: string; text: string } | null>(null);
  const [body, setBody] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const byLine = useMemo(() => {
    const m = new Map<string, Comment[]>();
    for (const c of comments) {
      if (!c.file || c.line == null) continue;
      const k = lineKey(c.file, c.side ?? "new", c.line);
      m.set(k, [...(m.get(k) ?? []), c]);
    }
    return m;
  }, [comments]);

  if (!diff.trim()) return <div className="muted pad">Brak zmian względem bazy.</div>;

  return (
    <div className="diff">
      <div className="diff-files small">
        {files.map((f) => (
          <a key={f.path} href={`#f-${f.path}`} className="mono">
            {f.path} <span className="add">+{f.adds}</span> <span className="del">−{f.dels}</span>
          </a>
        ))}
      </div>
      {files.map((f) => (
        <div key={f.path} className="diff-file" id={`f-${f.path}`}>
          <div className="diff-file-head" onClick={() => setCollapsed({ ...collapsed, [f.path]: !collapsed[f.path] })}>
            <span>{collapsed[f.path] ? "▸" : "▾"}</span>
            <span className="mono">{f.path}</span>
            <span className="muted small">{f.status}</span>
            <span className="add small">+{f.adds}</span>
            <span className="del small">−{f.dels}</span>
          </div>
          {!collapsed[f.path] && (
            <table className="diff-table">
              <tbody>
                {f.lines.map((l, i) => {
                  if (l.type === "hunk" || l.type === "meta")
                    return (
                      <tr key={i} className={`dl-${l.type}`}>
                        <td colSpan={3} className="mono">
                          {l.text}
                        </td>
                      </tr>
                    );
                  const side = l.type === "del" ? "old" : "new";
                  const no = (side === "old" ? l.oldNo : l.newNo)!;
                  const k = lineKey(f.path, side, no);
                  const lc = byLine.get(k) ?? [];
                  return (
                    <Fragment key={i}>
                      <tr
                        className={`dl-${l.type} dl-click`}
                        title="Kliknij, aby dodać komentarz"
                        onClick={() => {
                          setDraft({ key: k, file: f.path, line: no, side, text: l.text });
                          setBody("");
                        }}
                      >
                        <td className="ln">{l.oldNo ?? ""}</td>
                        <td className="ln">{l.newNo ?? ""}</td>
                        <td className="code mono">
                          <span className="sign">{l.type === "add" ? "+" : l.type === "del" ? "−" : " "}</span>
                          {l.text}
                        </td>
                      </tr>
                      {lc.map((c) => (
                        <tr key={`c${c.id}`} className="dl-comment">
                          <td colSpan={3}>
                            <InlineComment c={c} onResolve={onResolve} onDelete={onDelete} />
                          </td>
                        </tr>
                      ))}
                      {draft?.key === k && (
                        <tr className="dl-comment">
                          <td colSpan={3}>
                            <form
                              className="comment-form"
                              onSubmit={async (e) => {
                                e.preventDefault();
                                if (!body.trim()) return;
                                await onAddComment({ file: draft.file, line: draft.line, side: draft.side, line_text: draft.text, body });
                                setDraft(null);
                                setBody("");
                              }}
                            >
                              <textarea
                                autoFocus
                                rows={3}
                                value={body}
                                placeholder={`Komentarz do ${f.path}:${no}`}
                                onChange={(e) => setBody(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.currentTarget.form as HTMLFormElement).requestSubmit();
                                  if (e.key === "Escape") setDraft(null);
                                }}
                              />
                              <div className="row-end">
                                <button type="button" className="btn btn-ghost btn-small" onClick={() => setDraft(null)}>
                                  Anuluj
                                </button>
                                <button type="submit" className="btn btn-primary btn-small">
                                  Dodaj komentarz
                                </button>
                              </div>
                            </form>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      ))}
    </div>
  );
}

export function InlineComment({ c, onResolve, onDelete }: { c: Comment; onResolve: (c: Comment) => void; onDelete: (c: Comment) => void }) {
  return (
    <div className={`comment ${c.resolved ? "comment-resolved" : ""}`}>
      <div className="comment-body">{c.body}</div>
      {c.resolved && c.resolution && <div className="small muted">✓ {c.resolution}</div>}
      <div className="row small">
        <button className="btn btn-ghost btn-tiny" onClick={() => onResolve(c)}>
          {c.resolved ? "Otwórz ponownie" : "Rozwiązany"}
        </button>
        <button className="btn btn-ghost btn-tiny" onClick={() => onDelete(c)}>
          Usuń
        </button>
      </div>
    </div>
  );
}
