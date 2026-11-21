# Propozycje usprawnień: małe PR-y i zero-downtime deployment

Wnioski z dwóch sesji testowych na przykładowym serwisie `shop-api` (node:http + SQLite,
rolling deploy). Każda sesja przeszła pełną ścieżkę: plan → realizacja przez subagentów → review → merge.

## Co zrobiłem

**Sesja 1: SHOP-101 „Status zamówienia”** (kolumna `status`, `PATCH /orders/:id/status`)
- Planowanie: 2 Etapy, 2 Funkcje, 5 Kroków, 2 pytania. Realizacja `vk run` trwała 3 min i kosztowała ok. 1,5 $.
- Review: jeden komentarz do linii („schowaj endpoint za flagą, bo podczas rolling deployu stare
  instancje zwracają 404”). Sesja review wprowadziła flagę i testy. Potem merge wszystkich Kroków.

**Sesja 2: SHOP-102 „customer → customer_name”** (expand/contract, klienci migrują 2 tygodnie)
- Planowanie: 3 Etapy (expand → wyłączenie flagą → contract), 5 Funkcji, 10 Kroków, 3 pytania.
- Realizacja Etapów 1–2: 5 min, 6 Kroków. Etap 3 agent sam zablokował blokerem z opisem
  „dopiero po 2 tygodniach i wyłączeniu flagi na produkcji”.
- Ręcznie sprawdziłem zgodność N-1: stara wersja kodu (`main`) z nową migracją 003 przechodzi
  swoje testy (47/47).

## Co działa dobrze

- Agent planowania sam zaproponował expand/contract, triggery synchronizujące kolumny, warunkowy
  `UPDATE` przy współbieżnych zmianach statusu i flagę do wycofania starego pola.
  **Ale tylko dlatego, że informację o rolling deployu wpisałem w opis ticketu i w `CLAUDE.md` repo.**
  Domyślne prompty vk w ogóle nie poruszają tematu wdrożeń.
- Pytania z gotowymi propozycjami odpowiedzi i blokery sprawdzają się bardzo dobrze. Blokujące
  pytanie poprawnie zatrzymało Etap 3.
- Stackowanie Kroków działa: Krok `impl` widzi czerwone testy z Kroku `test`.

## Co przeszkadza przy małych PR-ach i zero-downtime

1. **Jednostką dostarczenia jest dziś ticket, a nie PR.** Wszystkie Kroki lądują w jednej gałęzi
   `vk/SHOP-101`: 335 linii, dwie Funkcje, które dałoby się wdrożyć osobno. Żeby zrobić z tego
   małe PR-y, trzeba ręcznie ciąć gałąź na commitach merge. W SHOP-102 jest gorzej: Etap 1 musi
   trafić na `main` i na produkcję **tygodnie** przed Etapem 3, a model z jedną gałęzią ticketu
   tego nie wyraża.
2. **Zielone są tylko granice Funkcji.** Wynik testów na kolejnych commitach gałęzi ticketu (SHOP-101):

   | Commit na `vk/SHOP-101` | Testy |
   |---|---|
   | 1.1.1 testy (czerwone) | 1 ✓ / 6 ✗ |
   | 1.1.2 migracja | 4 ✓ / 3 ✗ |
   | **1.1.3 API** | **7 ✓ / 0 ✗** |
   | 2.1.1 testy (czerwone) | 20 ✓ / 18 ✗ |
   | **2.1.2 PATCH** | **47 ✓ / 0 ✗** |

   Krok nie nadaje się więc na PR, bo CI byłoby czerwone. Naturalnym PR-em (i deployem) jest Funkcja,
   a narzędzie nie ma dla Funkcji ani diffu, ani gałęzi, ani akcji „wypchnij”.
3. **Status „done” oznacza lokalny merge.** Brakuje stanów „PR otwarty”, „zmergowany do main”
   i „wdrożony na produkcję”. Właśnie od nich zależą kolejne fazy expand/contract. Agent musiał
   wyrazić to blokerem z opisem, który trzeba zdjąć ręcznie i pamiętać o nim.
4. **Nic nie pilnuje działań po wdrożeniu.** Po review agent sam napisał: „trzeba ustawić
   `FEATURE_ORDER_STATUS_PATCH=true`; nic w repo tego nie opisuje”. Włączenie flagi, backfill czy
   wyłączenie starego pola giną w podsumowaniu sesji.
5. **Głębokie stosy niezrecenzowanych Kroków.** `vk run` uruchamia Krok, gdy zależność jest w Review
   (nie Done). W SHOP-102 powstał stos 6 Kroków, z których żaden nie był recenzowany. Jedna uwaga
   do 1.1.1 oznacza rebase pięciu kolejnych.
6. **Zgodność N-1 sprawdziłem ręcznie.** To ten sam schemat za każdym razem: kod z `main` plus
   migracje z gałęzi, a potem testy. Da się go zautomatyzować.
7. Drobne: każdy Krok daje dwa commity (commit agenta + merge `--no-ff` z polskim tytułem), więc
   historia jest dwa razy dłuższa. Krok `test` bywa większy od Kroku `impl` (+142 vs +25 linii),
   a mimo to jest osobno recenzowany.

## Propozycje (od największego zysku)

### P1. Funkcja = PR = jednostka wdrożenia
Zmiana modelu gałęzi: **gałąź Funkcji `vk/SHOP-101-1.1` od `base_branch`**, zamiast jednej gałęzi
ticketu. Kroki mergują się do gałęzi swojej Funkcji.
- Zależna Funkcja w tym samym repo startuje z gałęzi poprzedniej Funkcji (stacked PR, ten sam
  mechanizm co `computeBaseRef` dla Kroków). Po merge'u PR-a bazowego rebase na `main`.
- W UI przy Funkcji: zbiorczy diff (był w „Poza MVP”), licznik linii, przycisk/polecenie
  „Przygotuj PR”. Akcja robi `git push -u origin vk/SHOP-101-1.1` i tworzy PR (`gh pr create`)
  z opisem z pól Funkcji. Robi to skrypt na hoście, więc zasada „UI nie rozmawia z Claude”
  zostaje zachowana. Push nadal uruchamia człowiek, tylko jednym poleceniem zamiast ręcznie.
- Opcja „squash przy akceptacji Kroku”, czyli jeden commit na Krok, bez commitów merge.
- Miejsca w kodzie: `taskBranch`/`ensureTaskWorktree`/`mergeStep` w `src/core/git.ts`,
  `featureDiff` obok `stepDiff`.

### P2. Statusy wdrożenia i bramki deployu
Nowe stany Funkcji po `done`: **`pr_open → merged → deployed`** (ręcznie w UI albo przez MCP/API,
docelowo przez odczyt stanu PR z `gh`). Do tego zależność typu **„po wdrożeniu”**:
`depends_on: [{ key: "1.2", when: "deployed" }]` oraz opcjonalnie `not_before: "+14d"`.
- SHOP-102 zapisuje się wtedy bez ręcznego blokera: Etap 3 zależy od „2.1 deployed + 14 dni”
  i sam ruszy we właściwym momencie.
- `runnableSteps` uwzględnia warunek `when`. Domyślnie (`review`) zachowanie zostaje jak dziś.

### P3. Rollout jako pole Funkcji
Nowe pole Funkcji **`rollout`**: kolejność wdrożenia, flagi do przełączenia, migracje i backfille,
plan wycofania (rollback) oraz kroki po wdrożeniu jako checklista. Agent planowania je wypełnia,
UI pokazuje checklistę przy statusie `deployed`, a pole trafia do opisu PR.
To naprawia punkt 4: „włącz flagę X” staje się zadaniem z checkboxem, a nie zdaniem w logu.

### P4. Prompty i wytyczne „deploy-safe” w domyślnych ustawieniach
Dziś dobre decyzje zależą od tego, czy użytkownik wspomni o rolling deployu. Proponuję:
- W repozytorium nowe pole **„strategia wdrożenia”**: `rolling` / `blue-green` / `recreate`,
  plus informacja, czy migracje odpalają się przy starcie. Pole trafia do kontekstu jak `test_command`.
- Dopisek do `DEFAULT_LEVEL_FEATURE` (`src/core/defaults.ts`), mniej więcej:
  > Każda Funkcja musi dać się zmergować do gałęzi bazowej i wdrożyć osobno bez przestoju:
  > zmiany schematu tylko wstecznie zgodne (expand → migrate → contract w osobnych Funkcjach),
  > nowe zachowanie widoczne dla klientów za flagą, stara wersja (N-1) musi działać na nowym
  > schemacie. Usunięcia (kolumn, pól API, flag) planuj jako osobną Funkcję zależną „po wdrożeniu”.
- Dopisek do `DEFAULT_LEVEL_STEP`: limit rozmiaru przeniesiony na Funkcję (np. PR < 400 linii)
  zamiast na Krok. Jeśli Funkcja przekracza limit, planista ją dzieli.
- Gotowy szablon „Wytycznych zero-downtime” (np. przycisk „Wstaw przykład”): migracje,
  flagi, idempotentne backfille, kompatybilne kontrakty API.

### P5. Automatyczna weryfikacja przed Review
Rozszerzenie `finishStep` (opcjonalnie, włączane w repo):
- **Testy**: uruchom `test_command` w worktree i zapisz wynik przy Kroku (było w „Poza MVP”).
  W UI badge ✓/✗, przy Kroku `test` oczekiwane ✗.
- **Test zgodności N-1**: jeśli Funkcja zmienia `migrations/` (wzorzec ścieżek konfigurowalny
  w repo), zrób tymczasowy worktree z `base_branch`, nałóż nowe migracje i uruchom stare testy.
  Wynik pojawia się jako badge „zgodne wstecz”. Dokładnie to robiłem ręcznie w sesji 2.
- **Rozmiar**: ostrzeżenie, gdy diff Funkcji przekracza limit z P4.

### P6. Mniej rebase'ów: limit niezrecenzowanego stosu
Ustawienie `max_unreviewed_depth` (np. 2): `vk run` nie startuje Kroku, jeśli łańcuch jego
zależności ma więcej niż N Kroków w `review`. Do tego opcja „test + impl w jednym Kroku” dla
małych Funkcji. Krok `test` jest wtedy tylko pierwszym commitem, co daje mniej Kroków i mniej review.

### P7. Drobne usprawnienia codziennej pracy
- Widok **„Do zrobienia przeze mnie”** na stronie głównej, ze wszystkich ticketów naraz: pytania
  do odpowiedzi, Kroki w Review, Funkcje gotowe do PR, checklisty po wdrożeniu.
- Przycisk „Akceptuj Funkcję”: merge wszystkich jej Kroków w kolejności, zamiast klikania każdego osobno.
- Po akceptacji Funkcji sprzątanie gałęzi Kroków (dziś zostaje 5 gałęzi `vk/SHOP-101-*` na ticket).
- Tryb nieinteraktywny planowania (`/x/plan/KEY?auto=1`): plan zapisany od razu, decyzje jako
  pytania w UI. Używałem go w testach i dobrze się sprawdza przy prostych ticketach.

## Proponowana kolejność wdrożenia (też małymi PR-ami)

1. **P4** (same prompty i pole „strategia wdrożenia”): mały diff, natychmiastowy efekt.
2. **P3** (pole `rollout` + checklista).
3. **P1** w dwóch krokach: (a) zbiorczy diff Funkcji i polecenie „Przygotuj PR” na obecnej gałęzi
   ticketu (cherry-pick zakresu Funkcji), (b) docelowa zmiana modelu na gałęzie Funkcji.
4. **P2** (statusy wdrożenia i zależność „po wdrożeniu”).
5. **P5**, **P6**, **P7** według potrzeb.
