import {
  buildAssessment,
  escapeHtml,
} from "./risk-model.js";

const providers = {
  "https://blockstream.info/api": {
    name: "Blockstream",
    url: "https://blockstream.info/api",
  },
  "https://mempool.space/api": {
    name: "mempool.space",
    url: "https://mempool.space/api",
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
const HISTORY_PAGE_SIZE = 25;
let lastBatchResults = [];
let selectedBatchIndex = 0;

sampleButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const nextValue = button.dataset.address ?? "";
    addressInput.value = addressInput.value.trim()
      ? `${addressInput.value.trim()}\n${nextValue}`
      : nextValue;
    addressInput.focus();
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
  const addresses = parseAddressList(addressInput.value);
  const providerConfig = resolveProviderConfig(providerSelect.value, customProviderInput.value);

  if (addresses.length === 0) {
    renderError("Enter at least one Bitcoin address.");
    return;
  }

  if (!providerConfig.ok) {
    renderError(providerConfig.error);
    return;
  }

  await assessAddresses(addresses, providerConfig.value);
});

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
      const model = await assessSingleAddress(address, provider);
      results.push(model);
    }

    lastBatchResults = results;
    renderBatch(results);
    renderAssessment(results[0]);
    setStatus("Assessment complete.");
  } catch (error) {
    renderError(normalizeError(error));
  } finally {
    setLoadingState(false);
  }
}

async function assessSingleAddress(address, provider) {
  const addressSummaryPromise = fetchJson(`${provider.url}/address/${encodeURIComponent(address)}`);
  const txsPromise = fetchAddressHistory(address, provider.url);

  const [addressSummary, txs] = await Promise.all([
    addressSummaryPromise,
    txsPromise,
  ]);

  return buildAssessment(address, addressSummary, txs, provider);
}

async function fetchAddressHistory(address, providerBaseUrl) {
  const encodedAddress = encodeURIComponent(address);
  const recent = await fetchJson(`${providerBaseUrl}/address/${encodedAddress}/txs`);
  const history = [...recent];

  const confirmedCount = recent.filter((tx) => tx.status?.confirmed).length;
  let lastSeenTxid = recent.filter((tx) => tx.status?.confirmed).at(-1)?.txid;

  if (confirmedCount < HISTORY_PAGE_SIZE || !lastSeenTxid) {
    return history;
  }

  while (lastSeenTxid) {
    setStatus(`Scanning full history for ${truncateMiddle(address)}...`);
    const nextPage = await fetchJson(
      `${providerBaseUrl}/address/${encodedAddress}/txs/chain/${encodeURIComponent(lastSeenTxid)}`
    );

    if (!Array.isArray(nextPage) || nextPage.length === 0) {
      break;
    }

    history.push(...nextPage);

    if (nextPage.length < HISTORY_PAGE_SIZE) {
      break;
    }

    lastSeenTxid = nextPage.at(-1)?.txid;
  }

  return history;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
    },
  });

  if (!response.ok) {
    if (response.status === 400 || response.status === 404) {
      throw new Error("The address was not recognized by the selected API.");
    }

    throw new Error(`API request failed with status ${response.status}.`);
  }

  return response.json();
}

function renderAssessment(model) {
  riskBadge.className = `risk-badge ${model.risk.badgeClass}`;
  riskBadge.textContent = `${model.risk.tier} ${model.risk.label}`;

  resultSummary.classList.remove("empty");
  resultSummary.innerHTML = `
    <h2>${model.risk.headline}</h2>
    <p>${model.risk.explanation}</p>
    <p class="mono">${escapeHtml(model.address)}</p>
  `;

  metricsGrid.hidden = false;
  metricsGrid.innerHTML = `
    ${metric("Address type", model.addressType)}
    ${metric("Observed script type", model.outputScriptType ?? "Not observed in returned history")}
    ${metric("Spend profile", model.spendProfile.summary)}
    ${metric("Transactions analyzed", formatNumber(model.txsAnalyzed))}
    ${metric("Spent outputs", formatNumber(model.spentOutputs))}
    ${model.firstExposedAt ? metric("First exposed", `Block ${formatNumber(model.firstExposedAt.blockHeight)} &middot; ${formatBlockTime(model.firstExposedAt.blockTime)}`) : ""}
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
  batchSummary.textContent = `${results.length} address${results.length === 1 ? "" : "es"} scanned`;
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

function normalizeError(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unexpected error while querying the address.";
}
