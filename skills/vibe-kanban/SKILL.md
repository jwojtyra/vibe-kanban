---
name: vibe-kanban
description: Jak korzystać z vibe-kanban — lokalnego kanbanu dla Claude Code (tickety z wieloma repozytoriami, plan Etap → Funkcja → Krok, test-first, realizacja w git worktree, review). Użyj, gdy użytkownik chce utworzyć ticket, dodać repozytorium, zaplanować lub rozbić pracę na etapy/funkcje/kroki, sprawdzić stan ticketu albo uruchomić/skonfigurować vibe-kanban, oraz zawsze, gdy w sesji są narzędzia mcp vk_*.
---

# vibe-kanban

Lokalne narzędzie: ticket → plan w trzech poziomach → realizacja przez subagentów w osobnych
git worktree → review człowieka → lokalny merge. Nic nie jest wypychane (`git push`, PR) —
robi to człowiek. Serwer (UI + API + MCP) działa w Dockerze; sesje Claude na hoście.

## Kiedy który sposób

- **Konfiguracja / start serwera**: `/vibe-kanban:setup`. UI: http://localhost:4777 (domyślnie).
  Jeśli narzędzia `vk_*` nie odpowiadają — serwer nie działa: zaproponuj `/vibe-kanban:setup`
  albo sprawdzenie `~/.vk/docker.log`.
- **Nowy ticket / repozytorium** (dowolna sesja): narzędzia globalne `vk_list_repos`,
  `vk_add_repo`, `vk_update_repo`, `vk_list_tasks`, `vk_create_task` albo `/vibe-kanban:ticket`.
- **Planowanie i realizacja**: zawsze przez polecenia z UI (`bash <(curl -fsS 'http://localhost:4777/x/…')`),
  które otwierają dedykowane sesje z pełnym kontekstem ticketu (repozytoria, założenia, linki,
  zasoby read-only) i narzędziami planu. Nie próbuj planować ani implementować ticketu w zwykłej
  sesji — podaj użytkownikowi polecenie planowania (`plan_command` z `vk_create_task`).

## Model planu

| Poziom | Narzędzie | Klucz | Znaczenie |
|---|---|---|---|
| Etap | `vk_create_stage` | `SHOP-1-1` | Gruby klocek pracy, służy do podziału. |
| Funkcja | `vk_create_feature` | `SHOP-1-1.2` | Jedna zmiana funkcjonalna (API lub zachowanie). Wymaga `acceptance_tests` — scenariuszy dowodzących, że działa. Może obejmować kilka repo. |
| Krok | `vk_create_step` | `SHOP-1-1.2.3` | Najmniejszy klocek w JEDNYM repo (`repo`), `kind`: `test` albo `impl`. Wykonywany przez subagenta w osobnym worktree i osobno recenzowany. |

Zasady dobrego planu:
- **Test-first**: pierwszy Krok Funkcji w danym repo ma `kind: "test"` i dodaje testy akceptacyjne,
  które są CZERWONE; kolejne Kroki `impl` zależą od niego (`depends_on`) i je zazieleniają.
- Krok = jeden spójny diff do review (mały, samodzielnie weryfikowalny).
- Zależności tylko w obrębie poziomu: Kroki od Kroków, Funkcje od Funkcji (np. UI czeka na API),
  Etapy od Etapów. Zależność Funkcji/Etapu obowiązuje wszystkie ich Kroki.
- Najpierw uzgodnij plan z użytkownikiem, potem zapisz go narzędziami. Elementy powstają jako
  Draft — człowiek akceptuje je w UI.
- Klucze można podawać skrótem (`1.2`) w obrębie ticketu.

## Pytania, blokery, wytyczne

- **Pytania do człowieka**: zamiast zgadywać — `vk_ask_question` (przy ticketcie albo elemencie planu)
  z 2–4 propozycjami odpowiedzi; `blocking: true`, gdy bez odpowiedzi elementu nie da się zrealizować.
  Człowiek odpowiada w UI (radio z propozycjami albo własna odpowiedź). Odpowiedzi: `vk_list_questions`;
  własna odpowiedź może znaczyć „omówmy na czacie” / „mam dodatkowe pytania” — wtedy dopytaj wprost.
  Obsłużone pytania zamykaj `vk_close_question`.
- **Bloker**: `vk_set_blocker` z powodem, gdy elementu nie da się teraz realizować (pusty powód usuwa).
  Zablokowane elementy są w UI czerwone, z otwartymi pytaniami — żółte; ich Kroki nie ruszą.
- **Wytyczne** (`vk_get_guidelines`): wymagania techniczne użytkownika — obowiązują zawsze.
  Dopisuj (`vk_add_guideline`) tylko na wyraźną prośbę („zapisz w wytycznych, że…”).
- **Prompty poziomów** (Ustawienia) opisują, jak definiować Etap, Funkcję i Krok — są w kontekście sesji.

## W sesji Kroku (implementacja / review)

- Kontekst: `vk_get_item` (Krok, jego Funkcja i Etap, komentarze), `vk_get_task` (ticket i plan).
- Pracuj tylko w worktree Kroku; inne repozytoria i zasoby są tylko do odczytu.
- Komentarze z review: `vk_list_comments`, po poprawce `vk_resolve_comment`.
- Na koniec commit i `vk_submit_for_review` z podsumowaniem (w tym stan testów).
