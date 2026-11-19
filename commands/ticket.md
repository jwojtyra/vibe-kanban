---
description: Utwórz ticket vibe-kanban (np. z linku do Jiry) i wskaż jego repozytoria
argument-hint: "[link do ticketu lub opis]"
---

Utwórz ticket w vibe-kanban na podstawie: `$ARGUMENTS`

1. Użyj `vk_list_repos`, żeby zobaczyć znane repozytoria. Ustal z użytkownikiem, których dotyczy
   ticket. Brakujące lokalne repo dodaj `vk_add_repo` (nazwa, ścieżka, komenda testów, jeśli znana —
   możesz ją odczytać z package.json, Makefile, go.mod itp.).
2. Jeśli podano link do ticketu i masz narzędzia Jira/Atlassian — pobierz tytuł i opis.
3. Utwórz ticket `vk_create_task` (title, ticket_url, description, repos, ewentualnie założenia i linki).
4. Podaj użytkownikowi klucz ticketu i polecenie planowania (`plan_command`) do wklejenia
   w terminalu — planowanie odbywa się w osobnej, stałej sesji z pełnym kontekstem ticketu.
   Nie planuj w tej sesji.
