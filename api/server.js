"use strict";

const express = require("express");
const fs = require("node:fs/promises");
const path = require("node:path");


const app = express();

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT ?? 3000);

const PROJECT_ROOT = path.resolve(__dirname, "..");
const DATA_DIRECTORY = path.join(PROJECT_ROOT, "data");
const PUBLIC_DIRECTORY = path.join(PROJECT_ROOT, "public");

const ORDERS_PATH = path.join(
  DATA_DIRECTORY,
  "incoming_orders.json",
);

const LATEST_REPORT_PATH = path.join(
  DATA_DIRECTORY,
  "latest-report.json",
);


app.use(
  express.json({
    limit: "1mb",
  }),
);

app.use(
  express.static(PUBLIC_DIRECTORY),
);


function createHttpError(status, message) {
  const error = new Error(message);
  error.status = status;

  return error;
}


async function readJsonFile(filePath) {
  const fileContent = await fs.readFile(
    filePath,
    "utf8",
  );

  try {
    return JSON.parse(fileContent);
  } catch {
    throw createHttpError(
      500,
      `File JSON tidak valid: ${filePath}`,
    );
  }
}


function sanitizeOrder(order) {
  const sanitizedOrder = {
    ...order,
  };

  delete sanitizedOrder.is_injected_anomaly;

  return sanitizedOrder;
}


function validateReport(report) {
  if (
    report === null
    || Array.isArray(report)
    || typeof report !== "object"
  ) {
    throw createHttpError(
      400,
      "Report body harus berupa JSON object.",
    );
  }

  const requiredFields = [
    "analysis_id",
    "status",
    "record_count",
    "anomaly_count",
    "kpis",
    "anomalies",
  ];

  const missingFields = requiredFields.filter(
    (field) => !(field in report),
  );

  if (missingFields.length > 0) {
    throw createHttpError(
      400,
      `Report kehilangan field: ${missingFields.join(", ")}`,
    );
  }

  if (
    !Number.isInteger(report.record_count)
    || report.record_count < 0
  ) {
    throw createHttpError(
      400,
      "record_count harus berupa integer non-negatif.",
    );
  }

  if (
    !Number.isInteger(report.anomaly_count)
    || report.anomaly_count < 0
  ) {
    throw createHttpError(
      400,
      "anomaly_count harus berupa integer non-negatif.",
    );
  }

  if (!Array.isArray(report.anomalies)) {
    throw createHttpError(
      400,
      "anomalies harus berupa JSON array.",
    );
  }

  if (
    report.status !== "normal"
    && report.status !== "alert"
  ) {
    throw createHttpError(
      400,
      "status harus bernilai normal atau alert.",
    );
  }
}


app.get("/", (request, response) => {
  response.json({
    service: "PackSight Mini Mock ERP API",
    status: "running",
    api: "/api",
    health: "/health",
  });
});


app.get("/health", (request, response) => {
  response.json({
    status: "healthy",
    service: "mock-erp-api",
    timestamp: new Date().toISOString(),
  });
});


app.get("/api", (request, response) => {
  response.json({
    service: "PackSight Mini Mock ERP API",
    endpoints: {
      health: "GET /health",
      orders: "GET /api/orders",
      save_report: "POST /api/reports",
      latest_report: "GET /api/reports/latest",
    },
  });
});


app.get(
  "/api/orders",
  async (request, response) => {
    const orders = await readJsonFile(
      ORDERS_PATH,
    );

    if (!Array.isArray(orders)) {
      throw createHttpError(
        500,
        "incoming_orders.json harus berupa JSON array.",
      );
    }

    const sanitizedOrders = orders.map(
      sanitizeOrder,
    );

    response.json({
      source: "mock_erp",
      retrieved_at: new Date().toISOString(),
      record_count: sanitizedOrders.length,
      orders: sanitizedOrders,
    });
  },
);


app.post(
  "/api/reports",
  async (request, response) => {
    validateReport(request.body);

    const savedReport = {
      ...request.body,
      saved_at: new Date().toISOString(),
      stored_by: "mock-erp-api",
    };

    await fs.mkdir(
      DATA_DIRECTORY,
      {
        recursive: true,
      },
    );

    await fs.writeFile(
      LATEST_REPORT_PATH,
      JSON.stringify(savedReport, null, 2),
      "utf8",
    );

    response.status(201).json(savedReport);
  },
);


app.get(
  "/api/reports/latest",
  async (request, response) => {
    try {
      const report = await readJsonFile(
        LATEST_REPORT_PATH,
      );

      response.json(report);
    } catch (error) {
      if (error.code === "ENOENT") {
        throw createHttpError(
          404,
          "Belum ada laporan. Jalankan analisis terlebih dahulu.",
        );
      }

      throw error;
    }
  },
);


app.use((request, response) => {
  response.status(404).json({
    status: "error",
    message: (
      `Endpoint tidak ditemukan: `
      + `${request.method} ${request.originalUrl}`
    ),
  });
});


app.use(
  (error, request, response, next) => {
    const status = Number.isInteger(error.status)
      ? error.status
      : 500;

    console.error(
      `[${new Date().toISOString()}]`,
      error,
    );

    response.status(status).json({
      status: "error",
      message: (
        status === 500
          ? "Terjadi kesalahan internal pada server."
          : error.message
      ),
    });
  },
);


const server = app.listen(
  PORT,
  HOST,
  () => {
    console.log(
      `PackSight Mock ERP API berjalan di `
      + `http://${HOST}:${PORT}`,
    );

    console.log(
      `Orders endpoint: `
      + `http://${HOST}:${PORT}/api/orders`,
    );
  },
);


server.on("error", (error) => {
  console.error(
    "Server gagal dijalankan:",
    error,
  );

  process.exitCode = 1;
});