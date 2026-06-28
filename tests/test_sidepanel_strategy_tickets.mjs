import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

async function projectFile(name) {
  return readFile(new URL(`../${name}`, import.meta.url), "utf8");
}

test("sidepanel exposes the strategy ticket workbench controls", async () => {
  const html = await projectFile("sidepanel.html");

  for (const id of [
    "strategyHandoffSelect",
    "strategyTicketOwnerInput",
    "refreshStrategyTicketsBtn",
    "generateStrategyTicketsBtn",
    "strategyTicketStatus",
    "strategyTicketList"
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
  }
  assert.match(html, /策略实现票据/);
});

test("sidepanel exposes backtest import and strategy review controls", async () => {
  const html = await projectFile("sidepanel.html");

  for (const id of [
    "backtestOutcomeSelect",
    "backtestStatusSelect",
    "backtestPeriodInput",
    "backtestUniverseInput",
    "backtestBenchmarkInput",
    "backtestMetricsInput",
    "backtestCostsInput",
    "backtestRiskInput",
    "backtestArtifactInput",
    "backtestFailureNotesInput",
    "importBacktestResultBtn",
    "strategyBacktestList",
    "strategyReviewBacktestSelect",
    "strategyReviewGateSelect",
    "strategyReviewerInput",
    "strategyReviewChecklist",
    "createStrategyReviewBtn",
    "strategyReviewList"
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
  }
  assert.match(html, /回测反馈/);
  assert.match(html, /策略风险审查/);
  const statusSelect = html.match(/<select id="backtestStatusSelect">([\s\S]*?)<\/select>/)?.[1] || "";
  assert.doesNotMatch(statusSelect, /paper-ready/);
  assert.doesNotMatch(statusSelect, /live-ready/);
});

test("sidepanel wires strategy handoff and ticket API calls", async () => {
  const js = await projectFile("sidepanel.js");

  assert.match(js, /function renderStrategyTickets/);
  assert.match(js, /function generateStrategyTickets/);
  assert.match(js, /function updateStrategyTicketStatus/);
  assert.match(js, /function createStrategyHandoffFromDeliverable/);
  assert.match(js, /\/v1\/strategy-handoffs/);
  assert.match(js, /\/v1\/strategy-tickets/);
  assert.match(js, /\/v1\/strategy-tickets\/\$\{encodeURIComponent\(ticketId\)\}\/status/);
  assert.match(js, /data-ticket-status="in-progress"/);
  assert.match(js, /data-ticket-status="done"/);
  assert.match(js, /data-ticket-status="blocked"/);
  assert.match(js, /data-ticket-status="open"/);
});

test("sidepanel wires backtest and strategy review API calls", async () => {
  const js = await projectFile("sidepanel.js");

  assert.match(js, /function importBacktestResult/);
  assert.match(js, /function createStrategyReview/);
  assert.match(js, /function renderStrategyReviewChecklist/);
  assert.match(js, /\/v1\/backtest-results/);
  assert.match(js, /\/v1\/strategy-reviews/);
  for (const key of [
    "data_leakage",
    "out_of_sample_result",
    "costs_included",
    "drawdown_bounded",
    "turnover_feasible",
    "liquidity_capacity_checked",
    "paper_trading_record",
    "monitoring_plan",
    "kill_switch",
    "max_exposure",
    "operational_failure_plan",
    "manual_reviewer_approval"
  ]) {
    assert.match(js, new RegExp(key), `missing checklist key ${key}`);
  }
});
