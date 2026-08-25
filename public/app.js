"use strict";

const LATEST_REPORT_ENDPOINT = "/api/reports/latest";
const REQUEST_TIMEOUT_MS = 8_000;
const AUTO_REFRESH_INTERVAL_MS = 60_000;

const elements = Object.freeze({
  connectionPill: document.querySelector("#connection-pill"),
  connectionLabel: document.querySelector("#connection-label"),
  refreshButton: document.querySelector("#refresh-button"),
  retryButton: document.querySelector("#retry-button"),

  loadingState: document.querySelector("#loading-state"),
  errorState: document.querySelector("#error-state"),
  errorMessage: document.querySelector("#error-message"),
  dashboardContent: document.querySelector("#dashboard-content"),

  statusBadge: document.querySelector("#status-badge"),
  reportSummary: document.querySelector("#report-summary"),
  analysisTime: document.querySelector("#analysis-time"),

  recordCount: document.querySelector("#record-count"),
  normalCount: document.querySelector("#normal-count"),
  anomalyCount: document.querySelector("#anomaly-count"),
  defectRate: document.querySelector("#defect-rate"),
  averageLeadTime: document.querySelector("#average-lead-time"),
  totalOrderValue: document.querySelector("#total-order-value"),
  totalDefects: document.querySelector("#total-defects"),

  anomalyTotalLabel: document.querySelector("#anomaly-total-label"),
  anomalyTableBody: document.querySelector("#anomaly-table-body"),
  tableWrap: document.querySelector(".table-wrap"),
  noAnomalies: document.querySelector("#no-anomalies"),

  modelName: document.querySelector("#model-name"),
  sourceName: document.querySelector("#source-name"),
  analyzedAt: document.querySelector("#analyzed-at"),
  savedAt: document.querySelector("#saved-at"),
  analysisId: document.querySelector("#analysis-id"),
});

const integerFormatter = new Intl.NumberFormat("id-ID");

const decimalFormatter = new Intl.NumberFormat("id-ID", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

const currencyFormatter = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0,
});

const dateTimeFormatter = new Intl.DateTimeFormat("id-ID", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Jakarta",
});

let hasRenderedReport = false;
let isLoading = false;

function toFiniteNumber(value, fallback = 0) {
  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : fallback;
}

function formatInteger(value) {
  return integerFormatter.format(
    toFiniteNumber(value),
  );
}

function formatDecimal(value) {
  return decimalFormatter.format(
    toFiniteNumber(value),
  );
}

function formatCurrency(value) {
  return currencyFormatter.format(
    toFiniteNumber(value),
  );
}

function formatDateTime(value) {
  if (!value) {
    return "—";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "—";
  }

  return `${dateTimeFormatter.format(date)} WIB`;
}

function normalizeTextList(value, fallback) {
  if (!Array.isArray(value)) {
    return [fallback];
  }

  const normalizedValues = value
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);

  return normalizedValues.length > 0
    ? normalizedValues
    : [fallback];
}

function createElement(tagName, className, text) {
  const element = document.createElement(tagName);

  if (className) {
    element.className = className;
  }

  if (text !== undefined) {
    element.textContent = String(text);
  }

  return element;
}

function createTableCell(label) {
  const cell = document.createElement("td");
  cell.dataset.label = label;

  return cell;
}

function setConnectionState(state, label) {
  elements.connectionPill.dataset.state = state;
  elements.connectionLabel.textContent = label;
}

function validateReport(report) {
  if (
    report === null
    || Array.isArray(report)
    || typeof report !== "object"
  ) {
    throw new Error(
      "Format laporan dari API bukan JSON object.",
    );
  }

  const requiredFields = [
    "analysis_id",
    "status",
    "record_count",
    "normal_count",
    "anomaly_count",
    "kpis",
    "anomalies",
  ];

  const missingFields = requiredFields.filter(
    (field) => !(field in report),
  );

  if (missingFields.length > 0) {
    throw new Error(
      `Laporan tidak lengkap: ${missingFields.join(", ")}`,
    );
  }

  if (
    report.kpis === null
    || Array.isArray(report.kpis)
    || typeof report.kpis !== "object"
  ) {
    throw new Error("Field kpis bukan JSON object.");
  }

  if (!Array.isArray(report.anomalies)) {
    throw new Error("Field anomalies bukan JSON array.");
  }

  if (
    report.status !== "alert"
    && report.status !== "normal"
  ) {
    throw new Error("Status laporan tidak dikenali.");
  }
}

function setMetricSeverity(
  element,
  value,
  warningThreshold,
  dangerThreshold,
) {
  element.classList.remove(
    "metric-warning",
    "metric-danger",
  );

  if (value >= dangerThreshold) {
    element.classList.add("metric-danger");
    return;
  }

  if (value >= warningThreshold) {
    element.classList.add("metric-warning");
  }
}

function buildFindingContent(anomaly) {
  const container = document.createElement("div");

  const reasons = normalizeTextList(
    anomaly.reasons,
    "Pola berbeda dari data historis.",
  );

  const recommendations = normalizeTextList(
    anomaly.recommendations,
    "Lakukan pemeriksaan manual terhadap order.",
  );

  const findingList = createElement(
    "ul",
    "finding-list",
  );

  for (const reason of reasons) {
    findingList.append(
      createElement("li", "", reason),
    );
  }

  const recommendation = createElement(
    "p",
    "recommendation",
  );

  recommendation.append(
    createElement(
      "strong",
      "",
      "Next action",
    ),
    document.createTextNode(
      recommendations.join(" "),
    ),
  );

  container.append(
    findingList,
    recommendation,
  );

  return container;
}

function buildAnomalyRow(anomaly) {
  const row = document.createElement("tr");

  const orderCell = createTableCell("Order");
  orderCell.append(
    createElement(
      "span",
      "order-id",
      anomaly.order_id ?? "—",
    ),
  );

  const productCell = createTableCell("Product");
  productCell.append(
    createElement(
      "span",
      "product-name",
      anomaly.product_type ?? "Unknown product",
    ),
    createElement(
      "small",
      "product-meta",
      (
        `${formatInteger(anomaly.produced_quantity)} produced`
        + ` • ${formatInteger(anomaly.defect_count)} defect`
      ),
    ),
  );

  const defectRateValue = toFiniteNumber(
    anomaly.defect_rate_pct,
  );

  const defectRateCell = createTableCell("Defect rate");
  const defectRateBadge = createElement(
    "span",
    "metric-pill",
    `${formatDecimal(defectRateValue)}%`,
  );

  setMetricSeverity(
    defectRateBadge,
    defectRateValue,
    5,
    8,
  );

  defectRateCell.append(defectRateBadge);

  const leadTimeValue = toFiniteNumber(
    anomaly.lead_time_days,
  );

  const leadTimeCell = createTableCell("Lead time");
  const leadTimeBadge = createElement(
    "span",
    "metric-pill",
    `${formatDecimal(leadTimeValue)} hari`,
  );

  setMetricSeverity(
    leadTimeBadge,
    leadTimeValue,
    8,
    12,
  );

  leadTimeCell.append(leadTimeBadge);

  const orderValueCell = createTableCell("Order value");
  orderValueCell.append(
    createElement(
      "span",
      "order-value",
      formatCurrency(anomaly.order_value),
    ),
  );

  const findingCell = createTableCell(
    "Temuan dan rekomendasi",
  );

  findingCell.append(
    buildFindingContent(anomaly),
  );

  row.append(
    orderCell,
    productCell,
    defectRateCell,
    leadTimeCell,
    orderValueCell,
    findingCell,
  );

  return row;
}

function renderAnomalies(anomalies) {
  elements.anomalyTableBody.replaceChildren();

  const anomalyCount = anomalies.length;

  elements.anomalyTotalLabel.textContent = (
    `${formatInteger(anomalyCount)} order`
  );

  if (anomalyCount === 0) {
    elements.tableWrap.hidden = true;
    elements.noAnomalies.hidden = false;
    return;
  }

  elements.tableWrap.hidden = false;
  elements.noAnomalies.hidden = true;

  const fragment = document.createDocumentFragment();

  for (const anomaly of anomalies) {
    fragment.append(
      buildAnomalyRow(anomaly),
    );
  }

  elements.anomalyTableBody.append(fragment);
}

function renderReport(report) {
  const recordCount = toFiniteNumber(
    report.record_count,
  );

  const normalCount = toFiniteNumber(
    report.normal_count,
  );

  const anomalyCount = toFiniteNumber(
    report.anomaly_count,
  );

  const status = report.status;

  elements.statusBadge.dataset.status = status;

  elements.statusBadge.textContent = (
    status === "alert"
      ? "Alert • Review required"
      : "Normal • No anomaly"
  );

  elements.reportSummary.textContent = (
    status === "alert"
      ? (
        `${formatInteger(anomalyCount)} dari `
        + `${formatInteger(recordCount)} order `
        + "memerlukan pemeriksaan."
      )
      : (
        `${formatInteger(recordCount)} order `
        + "berada dalam pola normal."
      )
  );

  elements.analysisTime.textContent = (
    `Analisis terakhir: `
    + formatDateTime(report.analyzed_at)
  );

  elements.recordCount.textContent = (
    formatInteger(recordCount)
  );

  elements.normalCount.textContent = (
    `${formatInteger(normalCount)} order normal`
  );

  elements.anomalyCount.textContent = (
    formatInteger(anomalyCount)
  );

  elements.defectRate.textContent = (
    `${formatDecimal(
      report.kpis.overall_defect_rate_pct,
    )}%`
  );

  elements.averageLeadTime.textContent = (
    `${formatDecimal(
      report.kpis.average_lead_time_days,
    )} hari`
  );

  elements.totalOrderValue.textContent = (
    formatCurrency(
      report.kpis.total_order_value,
    )
  );

  elements.totalDefects.textContent = (
    `${formatInteger(
      report.kpis.total_defect_count,
    )} unit`
  );

  elements.modelName.textContent = (
    report.model?.name ?? "—"
  );

  elements.sourceName.textContent = (
    report.source ?? "—"
  );

  elements.analyzedAt.textContent = (
    formatDateTime(report.analyzed_at)
  );

  elements.savedAt.textContent = (
    formatDateTime(report.saved_at)
  );

  elements.analysisId.textContent = (
    report.analysis_id
  );

  renderAnomalies(report.anomalies);
}

async function requestLatestReport() {
  const controller = new AbortController();

  const timeoutId = window.setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS,
  );

  try {
    const response = await fetch(
      LATEST_REPORT_ENDPOINT,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
        cache: "no-store",
        signal: controller.signal,
      },
    );

    let responseBody;

    try {
      responseBody = await response.json();
    } catch {
      throw new Error(
        "API tidak mengembalikan JSON yang valid.",
      );
    }

    if (!response.ok) {
      throw new Error(
        responseBody.message
        ?? `HTTP error ${response.status}`,
      );
    }

    return responseBody;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function loadLatestReport() {
  if (isLoading) {
    return;
  }

  isLoading = true;

  elements.refreshButton.disabled = true;
  elements.refreshButton.textContent = "Memuat...";

  setConnectionState(
    "loading",
    "Memperbarui data...",
  );

  if (!hasRenderedReport) {
    elements.loadingState.hidden = false;
    elements.errorState.hidden = true;
    elements.dashboardContent.hidden = true;
  }

  try {
    const report = await requestLatestReport();

    validateReport(report);
    renderReport(report);

    hasRenderedReport = true;

    elements.loadingState.hidden = true;
    elements.errorState.hidden = true;
    elements.dashboardContent.hidden = false;

    setConnectionState(
      "success",
      "Mock ERP terhubung",
    );
  } catch (error) {
    const message = (
      error.name === "AbortError"
        ? "Permintaan ke API melebihi batas waktu."
        : error.message
    );

    setConnectionState(
      "error",
      "Koneksi bermasalah",
    );

    if (!hasRenderedReport) {
      elements.loadingState.hidden = true;
      elements.dashboardContent.hidden = true;
      elements.errorState.hidden = false;
      elements.errorMessage.textContent = message;
    }

    console.error(
      "Gagal memuat laporan PackSight:",
      error,
    );
  } finally {
    isLoading = false;

    elements.refreshButton.disabled = false;
    elements.refreshButton.textContent = "Refresh data";
  }
}

elements.refreshButton.addEventListener(
  "click",
  loadLatestReport,
);

elements.retryButton.addEventListener(
  "click",
  loadLatestReport,
);

window.setInterval(
  () => {
    if (document.visibilityState === "visible") {
      loadLatestReport();
    }
  },
  AUTO_REFRESH_INTERVAL_MS,
);

loadLatestReport();