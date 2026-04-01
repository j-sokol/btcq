import {
  buildAssessment,
  buildOutputAssessment,
  escapeHtml,
} from "./risk-model.js";

const providers = {
  "https://mempool.space/api": {
    name: "mempool.space",
    url: "https://mempool.space/api",
  },
  "https://blockstream.info/api": {
    name: "Blockstream",
    url: "https://blockstream.info/api",
  },
};

const riskForm = document.querySelector("#risk-form");
const addressInput = document.querySelector("#address-input");
const providerSelect = document.querySelector("#provider-select");
const customProviderInput = document.querySelector("#custom-provider-input");
const statusMessage = document.querySelector("#status-message");
const riskBadge = document.querySelector("#risk-badge");
const resultSummary = document.querySelector("#result-summary");
const metricsGrid = document.querySelector("#metrics-grid");
const actionsPanel = document.querySelector("#actions-panel");
const actionsList = document.querySelector("#actions-list");
const batchPanel = document.querySelector("#batch-panel");
const batchSummary = document.querySelector("#batch-summary");
const batchList = document.querySelector("#batch-list");
const sampleButtons = document.querySelectorAll(".sample-button");
const checkButton = document.querySelector("#check-button");
const resultPanel = document.querySelector("#result-panel");
const clearButton = document.querySelector("#clear-button");
const exportCsvButton = document.querySelector("#export-csv-button");
const HISTORY_PAGE_SIZE = 25;
const HISTORY_MAX_PAGES = 1;
let lastBatchResults = [];
let selectedBatchIndex = 0;

const tipCopyButton = document.querySelector("#tip-copy");
tipCopyButton?.addEventListener("click", () => {
  navigator.clipboard.writeText("btcq@lnbc.cz").then(() => {
    tipCopyButton.textContent = "Copied!";
    setTimeout(() => { tipCopyButton.textContent = "Copy"; }, 2000);
  });
});

exportCsvButton?.addEventListener("click", () => {
  if (lastBatchResults.length === 0) return;
  const rows = [
    ["address", "tier", "label", "address_type", "script_type", "has_spent", "spent_outputs", "first_exposed_block", "first_exposed_date", "balance_btc", "total_received_btc", "total_sent_btc"],
    ...lastBatchResults.map((r) => [
      r.address,
      r.risk.tier,
      r.risk.label,
      r.addressType,
      r.outputScriptType ?? "",
      r.hasSpent ? "yes" : "no",
      r.spentOutputs,
      r.firstExposedAt?.blockHeight ?? "",
      r.firstExposedAt ? formatBlockTime(r.firstExposedAt.blockTime) : "",
      satsToBtc(r.balance),
      satsToBtc(r.funded),
      satsToBtc(r.spent),
    ]),
  ];
  const csv = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `btcq-export-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

clearButton.addEventListener("click", () => {
  addressInput.value = "";
  addressInput.focus();
});

sampleButtons.forEach((button) => {
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    const nextValue = button.dataset.address ?? "";
    addressInput.value = nextValue;
    addressInput.focus();
    await submitAssessment();
  });
});

providerSelect.addEventListener("change", () => {
  const isCustom = providerSelect.value === "custom";
  customProviderInput.disabled = !isCustom;
  customProviderInput.closest(".endpoint-wrap").hidden = !isCustom;
  if (isCustom) {
    customProviderInput.focus();
  }
});

riskForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await submitAssessment();
});

async function submitAssessment() {
  const addresses = parseAddressList(addressInput.value);
  const providerConfig = resolveProviderConfig(providerSelect.value, customProviderInput.value);

  if (addresses.length === 0) {
    renderError("Enter at least one Bitcoin address or txid:vout output reference.");
    return;
  }

  if (!providerConfig.ok) {
    renderError(providerConfig.error);
    return;
  }

  await assessAddresses(addresses, providerConfig.value);
}

async function assessAddresses(addresses, provider) {
  setLoadingState(true);
  lastBatchResults = [];
  selectedBatchIndex = 0;
  batchPanel.hidden = true;
  batchList.innerHTML = "";

  try {
    setStatus(`Checking ${addresses.length} address${addresses.length === 1 ? "" : "es"} via ${provider.name}...`);
    const results = [];

    for (let index = 0; index < addresses.length; index += 1) {
      const address = addresses[index];
      setStatus(
        `Checking ${index + 1}/${addresses.length}: ${truncateMiddle(address)} via ${provider.name}...`
      );
      if (index > 0) await sleep(350);
      const model = await assessSingleAddress(address, provider);
      results.push(model);
    }

    lastBatchResults = results;
    renderBatch(results);
    renderAssessment(results[0]);
    setStatus("Assessment complete.");
    pushAddressesToUrl(addresses);
  } catch (error) {
    renderError(normalizeError(error));
  } finally {
    setLoadingState(false);
  }
}

async function assessSingleAddress(address, provider) {
  const outpoint = parseOutpoint(address);
  if (outpoint) {
    const tx = await fetchJson(`${provider.url}/tx/${encodeURIComponent(outpoint.txid)}`);
    const outspend = await fetchJson(
      `${provider.url}/tx/${encodeURIComponent(outpoint.txid)}/outspend/${outpoint.vout}`
    );
    return buildOutputAssessment(address, tx, outpoint.vout, outspend, provider);
  }

  const addressSummaryPromise = fetchJson(`${provider.url}/address/${encodeURIComponent(address)}`);
  const historyPromise = fetchAddressHistory(address, provider.url);

  const [addressSummary, { txs, truncated }] = await Promise.all([
    addressSummaryPromise,
    historyPromise,
  ]);

  return buildAssessment(address, addressSummary, txs, provider, truncated);
}

async function fetchAddressHistory(address, providerBaseUrl) {
  const encodedAddress = encodeURIComponent(address);
  const recent = await fetchJson(`${providerBaseUrl}/address/${encodedAddress}/txs`);
  const history = [...recent];

  const confirmedCount = recent.filter((tx) => tx.status?.confirmed).length;
  let lastSeenTxid = recent.filter((tx) => tx.status?.confirmed).at(-1)?.txid;

  if (confirmedCount < HISTORY_PAGE_SIZE || !lastSeenTxid) {
    return { txs: history, truncated: false };
  }

  let page = 1;
  while (lastSeenTxid && page < HISTORY_MAX_PAGES) {
    setStatus(`Scanning history for ${truncateMiddle(address)} (page ${page + 1})...`);
    const nextPage = await fetchJson(
      `${providerBaseUrl}/address/${encodedAddress}/txs/chain/${encodeURIComponent(lastSeenTxid)}`
    );

    if (!Array.isArray(nextPage) || nextPage.length === 0) {
      break;
    }

    history.push(...nextPage);
    page += 1;

    if (nextPage.length < HISTORY_PAGE_SIZE) {
      break;
    }

    lastSeenTxid = nextPage.at(-1)?.txid;
  }

  return { txs: history, truncated: page >= HISTORY_MAX_PAGES };
}

async function fetchJson(url, attempt = 0) {
  const MAX_RETRIES = 3;
  const RETRY_DELAYS = [1000, 2000, 4000];

  let response;
  try {
    response = await fetch(url, { headers: { accept: "application/json" } });
  } catch {
    if (attempt < MAX_RETRIES) {
      const delay = RETRY_DELAYS[attempt];
      setStatus(`Network error — retrying in ${delay / 1000}s… (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await sleep(delay);
      return fetchJson(url, attempt + 1);
    }
    throw new Error(
      "Could not reach the API. Check your connection or try a different endpoint."
    );
  }

  if (response.status === 429) {
    if (attempt < MAX_RETRIES) {
      const retryAfter = Number(response.headers.get("retry-after")) || 0;
      const delay = retryAfter > 0 ? retryAfter * 1000 : RETRY_DELAYS[attempt];
      setStatus(`Rate limited — retrying in ${delay / 1000}s… (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await sleep(delay);
      return fetchJson(url, attempt + 1);
    }
    throw new Error(
      "The API is rate-limiting this checker. Wait a moment and try again, or switch to the other endpoint."
    );
  }

  if (!response.ok) {
    if (response.status === 400 || response.status === 404) {
      throw new Error("The address was not recognized by the selected API.");
    }
    throw new Error(`API request failed with status ${response.status}.`);
  }

  return response.json();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function renderAssessment(model) {
  riskBadge.className = `risk-badge ${model.risk.badgeClass}`;
  riskBadge.innerHTML = `<span class="badge-label">${model.risk.label}</span><span class="badge-tier">${model.risk.tier}</span>`;
  resultPanel.dataset.risk = model.risk.badgeClass;

  resultSummary.classList.remove("empty");
  resultSummary.innerHTML = `
    <h2>${model.risk.headline}</h2>
    <p>${model.risk.explanation}</p>
    <p class="mono">${escapeHtml(model.address)}</p>
  `;

  metricsGrid.hidden = false;
  metricsGrid.innerHTML = `
    ${metric(model.subjectKind === "output" ? "Output type" : "Address type", model.addressType)}
    ${metric("Observed script type", model.outputScriptType ?? "Not observed in returned history")}
    ${model.knownExposure ? metric("Historical caveat", model.knownExposure.note) : ""}
    ${metric("Spend profile", model.spendProfile.summary)}
    ${metric("Transactions analyzed", model.historyTruncated
      ? `${formatNumber(model.txsAnalyzed)} (first ${HISTORY_MAX_PAGES} pages — address has ${formatNumber(model.txCount)} total)`
      : formatNumber(model.txsAnalyzed))}
    ${metric("Spent outputs", formatNumber(model.spentOutputs))}
    ${model.firstExposedAt ? metric("Spend observed", `Block ${formatNumber(model.firstExposedAt.blockHeight)} &middot; ${formatBlockTime(model.firstExposedAt.blockTime)}`) : ""}
    ${metric("Address reuse", model.isReused ? "Likely reused" : "No reuse signal detected")}
    ${metric("Spend exposure", model.hasSpent ? "Spend history detected" : "No spend detected")}
    ${metric("Total received", formatBtc(model.funded))}
    ${metric("Total sent", formatBtc(model.spent))}
    ${metric("Current balance", formatBtc(model.balance))}
    ${metric("Data source", model.provider.name)}
  `;

  actionsPanel.hidden = false;
  actionsList.innerHTML = model.risk.actions.map((item) => `<li>${item}</li>`).join("");
}

function renderBatch(results) {
  if (results.length === 0) {
    batchPanel.hidden = true;
    return;
  }

  batchPanel.hidden = false;
  const tierCounts = results.reduce((acc, r) => {
    acc[r.risk.badgeClass] = (acc[r.risk.badgeClass] || { label: r.risk.label, count: 0 });
    acc[r.risk.badgeClass].count += 1;
    return acc;
  }, {});
  const tierSummary = Object.entries(tierCounts)
    .map(([cls, { label, count }]) => `<span class="risk-badge mini ${cls}">${count} ${label}</span>`)
    .join(" ");
  batchSummary.innerHTML = `${results.length} address${results.length === 1 ? "" : "es"} &nbsp; ${tierSummary}`;
  batchList.innerHTML = results
    .map((result, index) => {
      const activeClass = index === selectedBatchIndex ? " active" : "";
      return `
        <button class="batch-item${activeClass}" type="button" data-batch-index="${index}">
          <div class="batch-item-top">
            <span class="batch-address">${escapeHtml(result.address)}</span>
            <span class="risk-badge ${result.risk.badgeClass}">${result.risk.tier}</span>
          </div>
          <div class="batch-item-bottom">
            <span class="batch-meta">${result.addressType} • ${escapeHtml(result.risk.label)}</span>
            <span class="batch-meta">${result.hasSpent ? "Spend detected" : "No spend detected"}</span>
          </div>
        </button>
      `;
    })
    .join("");

  batchList.querySelectorAll("[data-batch-index]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedBatchIndex = Number(button.dataset.batchIndex);
      renderBatch(lastBatchResults);
      renderAssessment(lastBatchResults[selectedBatchIndex]);
    });
  });
}

function renderError(message) {
  riskBadge.className = "risk-badge unknown";
  riskBadge.textContent = "Check failed";
  resultSummary.classList.remove("empty");
  resultSummary.innerHTML = `
    <h2>Unable to assess this address</h2>
    <p>${escapeHtml(message)}</p>
  `;
  metricsGrid.hidden = true;
  actionsPanel.hidden = true;
  batchPanel.hidden = true;
  setStatus(message);
}

function parseAddressList(value) {
  return [...new Set(value.split(/[\n,]+/).map((entry) => entry.trim()).filter(Boolean))];
}

function parseOutpoint(value) {
  const match = value.match(/^([0-9a-fA-F]{64}):(\d+)$/);
  if (!match) return null;

  return {
    txid: match[1].toLowerCase(),
    vout: Number(match[2]),
  };
}

function resolveProviderConfig(selectedValue, customValue) {
  if (selectedValue !== "custom") {
    return {
      ok: true,
      value: providers[selectedValue],
    };
  }

  const trimmed = customValue.trim().replace(/\/+$/, "");

  if (!trimmed) {
    return {
      ok: false,
      error: "Enter a custom Esplora-compatible API endpoint.",
    };
  }

  try {
    const url = new URL(trimmed);
    return {
      ok: true,
      value: {
        name: `Custom endpoint (${url.host})`,
        url: trimmed,
      },
    };
  } catch {
    return {
      ok: false,
      error: "Custom endpoint must be a valid URL.",
    };
  }
}

function metric(label, value) {
  return `<div><dt>${label}</dt><dd>${value}</dd></div>`;
}

function formatBtc(sats) {
  const btc = Number(sats) / 100000000;
  return `${btc.toLocaleString(undefined, {
    minimumFractionDigits: btc === 0 ? 0 : 8,
    maximumFractionDigits: 8,
  })} BTC`;
}

function formatNumber(value) {
  return Number(value).toLocaleString();
}

function formatBlockTime(blockTime) {
  return new Date(blockTime * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function setStatus(message) {
  statusMessage.textContent = message;
}

function setLoadingState(isLoading) {
  checkButton.disabled = isLoading;
  checkButton.textContent = isLoading ? "Checking..." : "Assess risk";
}

function truncateMiddle(value) {
  if (value.length < 18) return value;
  return `${value.slice(0, 8)}...${value.slice(-8)}`;
}

function satsToBtc(sats) {
  return (Number(sats) / 100000000).toFixed(8);
}

function csvCell(value) {
  const str = String(value ?? "");
  return str.includes(",") || str.includes('"') || str.includes("\n")
    ? `"${str.replaceAll('"', '""')}"`
    : str;
}

function normalizeError(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unexpected error while querying the address.";
}

function pushAddressesToUrl(addresses) {
  const params = new URLSearchParams();
  addresses.forEach((a) => params.append("address", a));
  const newUrl = `${location.pathname}?${params}`;
  history.replaceState(null, "", newUrl);
}

// On load: if ?address= params are present, pre-fill and auto-run
(function bootFromUrl() {
  const params = new URLSearchParams(location.search);
  const addresses = params.getAll("address").filter(Boolean);
  if (addresses.length === 0) return;

  addressInput.value = addresses.join("\n");

  const providerConfig = resolveProviderConfig(providerSelect.value, customProviderInput.value);
  if (providerConfig.ok) {
    assessAddresses(addresses, providerConfig.value);
  }
}());
