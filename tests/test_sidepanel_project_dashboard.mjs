import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

async function projectFile(name) {
  return readFile(new URL(`../${name}`, import.meta.url), "utf8");
}

test("sidepanel exposes the project stage dashboard controls", async () => {
  const html = await projectFile("sidepanel.html");

  for (const id of [
    "projectSelect",
    "projectStageReviewerInput",
    "projectStageNoteInput",
    "projectDashboard"
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
  }
  assert.match(html, /阶段确认人/);
  assert.match(html, /阶段确认备注/);
});

test("sidepanel exposes project brief and capture plan controls", async () => {
  const html = await projectFile("sidepanel.html");

  for (const id of [
    "enqueueNextPagesBtn",
    "runVaultDoctorBtn",
    "vaultDoctorStatus",
    "vaultDoctorResults",
    "rebuildLineageBtn",
    "lineageStatus",
    "lineageResults",
    "projectResearchQuestionInput",
    "projectTargetOutputInput",
    "projectInclusionRulesInput",
    "projectExclusionRulesInput",
    "projectEvidenceThresholdInput",
    "projectReviewPolicyInput",
    "projectStrategyScopeInput",
    "saveProjectBriefBtn",
    "capturePlanUrlsInput",
    "capturePlanSourceTypeInput",
    "capturePlanPriorityInput",
    "capturePlanReasonInput",
    "discoverCurrentPageLinksBtn",
    "createCapturePlansBtn",
    "enqueueApprovedPlansBtn",
    "capturePlanList"
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
  }
  assert.match(html, /Vault Doctor/);
  assert.match(html, /重建 Lineage/);
  assert.match(html, /项目 Brief/);
  assert.match(html, /Capture Plan/);
});

test("sidepanel exposes manual selector extraction fallback", async () => {
  const html = await projectFile("sidepanel.html");
  const js = await projectFile("sidepanel.js");

  for (const id of ["manualSelectorInput", "readSelectorBtn"]) {
    assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
  }
  assert.match(html, /正文 CSS 选择器/);
  assert.match(js, /function readManualSelectorFromPage/);
  assert.match(js, /function extractManualSelectorPage/);
  assert.match(js, /func: extractManualSelectorPage/);
  assert.match(js, /args: \[selector\]/);
  assert.match(js, /profile: "manual-selector"/);
  assert.match(js, /manualSelector: selector/);
  assert.match(js, /kind: "page\+manual-selector"/);
});

test("sidepanel injects browser site profile bundle before inline extraction fallback", async () => {
  const js = await projectFile("sidepanel.js");

  assert.match(js, /function injectSiteProfileBundle/);
  assert.match(js, /files: \["extractors\/browser_site_profiles\.js"\]/);
  assert.match(js, /function extractReadablePageFromTab/);
  assert.match(js, /await injectSiteProfileBundle\(tabId\)/);
  assert.match(js, /window\.QCSmartReaderProfiles\?\.extractReadablePage/);
  assert.match(js, /falling back to inline extractor/);
});

test("sidepanel wires project dashboard and stage confirmation APIs", async () => {
  const js = await projectFile("sidepanel.js");

  assert.match(js, /function renderProjectDashboard/);
  assert.match(js, /function loadProjectDashboard/);
  assert.match(js, /function confirmProjectStage/);
  assert.match(js, /function stageStatusLabel/);
  assert.match(js, /\/v1\/projects\/\$\{encodeURIComponent\(currentProjectId\(\)\)\}\/dashboard/);
  assert.match(js, /\/v1\/projects\/\$\{encodeURIComponent\(currentProjectId\(\)\)\}\/stages\/\$\{encodeURIComponent\(stageId\)\}\/confirm/);
  assert.match(js, /data-confirm-project-stage/);
  assert.match(js, /projectDashboard/);
  assert.match(js, /stale_topic_package_count/);
  assert.match(js, /stale_deliverable_count/);
});

test("sidepanel wires project brief and capture plan APIs", async () => {
  const js = await projectFile("sidepanel.js");

  for (const fn of [
    "runVaultDoctor",
    "renderVaultDoctor",
    "rebuildLineage",
    "renderLineage",
    "loadProjectBrief",
    "saveProjectBrief",
    "createNextPageCapturePlans",
    "discoverCurrentPageLinksToCapturePlans",
    "loadCapturePlans",
    "createCapturePlans",
    "updateCapturePlanStatus",
    "enqueueApprovedCapturePlans",
    "renderCapturePlans"
  ]) {
    assert.match(js, new RegExp(`function ${fn}`), `missing function ${fn}`);
  }
  assert.match(js, /\/v1\/vault\/doctor/);
  assert.match(js, /\/v1\/lineage\/rebuild/);
  assert.match(js, /lineageResults/);
  assert.match(js, /\/v1\/projects\/\$\{encodeURIComponent\(currentProjectId\(\)\)\}\/brief/);
  assert.match(js, /\/v1\/capture-plans/);
  assert.match(js, /setLocalizedStatus\("currentPage\.nextPages\.working", \{ count: nextPages\.length \}\)/);
  assert.match(js, /setLocalizedStatus\("currentPage\.nextPages\.success", \{ count: nextPages\.length \}\)/);
  assert.match(js, /next_pages: extracted\.nextPages \|\| \[\]/);
  assert.match(js, /next_pages: source\?\.nextPages \|\| \[\]/);
  assert.match(js, /pagination_from_url/);
  assert.match(js, /chrome\.scripting\.executeScript/);
  assert.match(js, /func: discoverCandidateLinksFromPage/);
  assert.match(js, /function discoverCandidateLinksFromPage/);
  assert.match(js, /function normalizeDiscoveredLinkCandidates/);
  assert.match(js, /function inferCapturePlanSourceType/);
  assert.match(js, /discovered_from_url/);
  assert.match(js, /\/v1\/capture-plans\/enqueue-approved/);
  assert.match(js, /\/v1\/capture-plans\/\$\{encodeURIComponent\(planId\)\}\/status/);
  assert.match(js, /data-capture-plan-status="approved"/);
  assert.match(js, /data-capture-plan-status="rejected"/);
});

test("sidepanel preserves actionable batch failure categories", async () => {
  const js = await projectFile("sidepanel.js");

  assert.match(js, /errorCategory: ""/);
  assert.match(js, /jobItem\.error_category/);
  assert.match(js, /function inferBatchFailureCategory/);
  assert.match(js, /function batchErrorCategoryLabel/);
  assert.match(js, /error\.errorCategory \|\| inferBatchFailureCategory\(item\.error\)/);
  assert.match(js, /error_category: item\.errorCategory/);
  assert.match(js, /error_category: errorCategory/);
  assert.match(js, /pagination_needed: "分页未采完"/);
  assert.match(js, /attachment_missing: "附件未保存"/);
  assert.match(js, /pagination_needed: 1/);
  assert.match(js, /attachment_missing: 1/);
  assert.match(js, /错误类型：/);
});

test("sidepanel wires retry and backoff for background batch tabs", async () => {
  const js = await projectFile("sidepanel.js");

  assert.match(js, /BATCH_MAX_BROWSER_ATTEMPTS = 3/);
  assert.match(js, /BATCH_RETRYABLE_FAILURE_LIMITS/);
  for (const category of ["page_timeout", "network_error", "service_error", "extraction_empty", "unknown"]) {
    assert.match(js, new RegExp(`${category}:`), `missing retry policy for ${category}`);
  }
  assert.match(js, /async function captureBatchItemWithRetries/);
  assert.match(js, /function shouldRetryBatchFailure/);
  assert.match(js, /function batchBackoffDelayMs/);
  assert.match(js, /function maxBatchAttemptsForCategory/);
  assert.match(js, /await sleep\(delayMs\)/);
  assert.match(js, /processClaimedBatchItem[\s\S]*captureBatchItemWithRetries\(item, \{ index, total \}\)/);
  assert.match(js, /processBatchQueueLocally[\s\S]*captureBatchItemWithRetries\(item, \{/);
  assert.match(js, /browser_attempts: browserAttempts/);
  assert.match(js, /retry_limit: maxBatchAttemptsForCategory\(item\.errorCategory\)/);
});

test("sidepanel normalizes duplicate URLs and sends canonical capture metadata", async () => {
  const js = await projectFile("sidepanel.js");

  assert.match(js, /function normalizeUrl/);
  assert.match(js, /function isTrackingQueryParam/);
  assert.match(js, /lowered\.startsWith\("utm_"\)/);
  assert.ok(js.includes('parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\\./, "");'));
  assert.match(js, /parsed\.hash = ""/);
  assert.match(js, /canonicalUrl: extracted\.canonicalUrl \|\| normalizeUrl/);
  assert.match(js, /document\.querySelector\('link\[rel="canonical"\]/);
  assert.match(js, /canonical_url: extracted\.canonicalUrl \|\| normalizeUrl\(extracted\.url\)/);
  assert.match(js, /canonical_url: item\.canonicalUrl \|\| normalizeUrl\(item\.url\)/);
});

test("sidepanel records exact extraction truncation metadata", async () => {
  const js = await projectFile("sidepanel.js");

  assert.match(js, /const EXTRACTION_LIMITS = \{/);
  for (const key of ["headings", "blocks", "blockTextChars", "codeBlocks", "images", "attachments", "links", "nextPages"]) {
    assert.match(js, new RegExp(`${key}:`), `missing extraction limit for ${key}`);
  }
  assert.match(js, /const truncation = \{\}/);
  assert.match(js, /function limitExtractionItems/);
  assert.match(js, /function recordExtractionLimit/);
  assert.match(js, /function hasExtractionTruncation/);
  assert.match(js, /truncated: hasExtractionTruncation\(\)/);
  assert.match(js, /truncation,/);
  assert.match(js, /recordExtractionLimit\(\s*"comments"/);
  assert.match(js, /truncation\.blockTextChars = blockTextStats/);
});

test("sidepanel renders the five project pipeline stages", async () => {
  const server = await projectFile("companion_service/server.py");

  for (const stage of ["collect", "screen", "research", "deliver", "strategy"]) {
    assert.match(server, new RegExp(`"${stage}"`), `missing stage ${stage}`);
  }
  assert.match(server, /PROJECT_STAGES = \("collect", "screen", "research", "deliver", "strategy"\)/);
  assert.match(server, /project_stage_confirmations/);
  assert.match(server, /project_briefs/);
  assert.match(server, /capture_plans/);
  assert.match(server, /def project_dashboard/);
  assert.match(server, /def confirm_project_stage/);
  assert.match(server, /def upsert_project_brief/);
  assert.match(server, /def enqueue_approved_capture_plans/);
  assert.match(server, /stale_topic_package_count/);
  assert.match(server, /stale_deliverable_count/);
  assert.match(server, /def mark_lineage_dependents_stale/);
});

test("sidepanel includes low-quality captures in the review queue", async () => {
  const js = await projectFile("sidepanel.js");

  assert.match(js, /needs_review: "needs review"/);
  assert.match(js, /\["needs_review", "new", "extracted"\]\.map/);
  assert.match(js, /function qualitySummary/);
  assert.match(js, /flags\.low_text/);
  assert.match(js, /flags\.truncated/);
  assert.match(js, /flags\.auth_required/);
  assert.match(js, /flags\.pagination_needed/);
  assert.match(js, /flags\.attachment_missing/);
  assert.match(js, /需审：/);
});
