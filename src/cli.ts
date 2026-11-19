#!/usr/bin/env -S node --no-warnings=ExperimentalWarning
import { Command } from "commander";
import { startHttpServer } from "./http/server.js";
import { startMcpServer } from "./mcp/server.js";
import { execSubtask, openSession, planSession, runTask } from "./core/sessions.js";

const program = new Command();
program.name("vk").description("vibe-kanban — lokalny kanban zadań dla Claude Code").version("0.1.0");

const fatal = (e: unknown) => {
  console.error(`vk: ${(e as Error).message ?? e}`);
  process.exit(1);
};

program
  .command("serve")
  .description("Uruchamia lokalne UI i API (http://localhost:PORT)")
  .option("-p, --port <port>", "port", process.env.VK_PORT ?? "4777")
  .option("--host <host>", "adres nasłuchu (w Dockerze 0.0.0.0)", process.env.VK_BIND ?? "127.0.0.1")
  .action((o) => startHttpServer(Number(o.port), o.host).catch(fatal));

program
  .command("plan <taskKey>")
  .description("Otwiera (lub wznawia) stałą sesję planowania zadania")
  .action((key) => planSession(key).then((c) => process.exit(c), fatal));

program
  .command("run <taskKey>")
  .description("Realizuje zaakceptowane podzadania (subagenci w worktree), wynik -> Review")
  .option("-c, --concurrency <n>", "ile podzadań równolegle")
  .action((key, o) => runTask(key, { concurrency: o.concurrency ? Number(o.concurrency) : undefined }).then(() => process.exit(0), fatal));

program
  .command("exec <subtaskKey>")
  .description("Uruchamia subagenta dla jednego podzadania")
  .option("--force", "uruchom mimo niegotowych zależności")
  .action((key, o) => execSubtask(key, o).then(() => process.exit(0), fatal));

program
  .command("open <subtaskKey>")
  .description("Otwiera sesję pracy/review nad podzadaniem (zna komentarze i zadanie główne)")
  .option("--agent", "wznów sesję subagenta, który implementował podzadanie")
  .option("--fresh", "rozpocznij nową sesję review zamiast wznawiać poprzednią")
  .action((key, o) => openSession(key, o).then((c) => process.exit(c), fatal));

program
  .command("mcp")
  .description("Serwer MCP (stdio). Bez --task: tryb globalny (projekty, repozytoria, zadania)")
  .option("--task <key>")
  .option("--subtask <key>")
  .action((o) => startMcpServer(o.task, o.subtask).catch(fatal));

program.parseAsync().catch(fatal);
