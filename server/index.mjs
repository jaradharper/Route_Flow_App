import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const ROUTEFLOW_DIR = path.join(ROOT_DIR, ".routeflow");
const TOKEN_PATH = path.join(ROUTEFLOW_DIR, "salesforce-token.json");
const STATE_PATH = path.join(ROUTEFLOW_DIR, "oauth-state.json");

await loadEnvFile(path.join(ROOT_DIR, ".env"));

const app = express();
const port = Number(process.env.ROUTEFLOW_SERVER_PORT || 5174);
const frontendUrl = process.env.ROUTEFLOW_FRONTEND_URL || "http://localhost:5173";

app.use(express.json());
app.use((request, response, next) => {
  response.setHeader("Access-Control-Allow-Origin", frontendUrl);
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");

  if (request.method === "OPTIONS") {
    response.sendStatus(204);
    return;
  }

  next();
});

app.get("/api/salesforce/login", async (_request, response) => {
  try {
    const config = getSalesforceConfig();
    const state = crypto.randomBytes(24).toString("hex");
    await writeJson(STATE_PATH, { state, createdAt: new Date().toISOString() });

    const authUrl = new URL("/services/oauth2/authorize", config.loginUrl);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", config.clientId);
    authUrl.searchParams.set("redirect_uri", config.redirectUri);
    authUrl.searchParams.set("scope", "api refresh_token");
    authUrl.searchParams.set("state", state);

    response.redirect(authUrl.toString());
  } catch (error) {
    response.status(500).send(renderCallbackPage("Salesforce setup is incomplete.", getUserMessage(error)));
  }
});

app.get("/api/salesforce/callback", async (request, response) => {
  const salesforceError = request.query.error;

  if (salesforceError) {
    response.redirect(getFrontendRedirect("error", `Salesforce login failed: ${request.query.error_description || salesforceError}`));
    return;
  }

  try {
    const config = getSalesforceConfig();
    const expectedState = await readJson(STATE_PATH);

    if (!request.query.state || request.query.state !== expectedState?.state) {
      throw new Error("Salesforce login state did not match. Please try connecting again.");
    }

    const token = await exchangeAuthorizationCode(config, String(request.query.code || ""));
    await writeJson(TOKEN_PATH, {
      ...token,
      savedAt: new Date().toISOString(),
    });
    await safeUnlink(STATE_PATH);

    response.redirect(getFrontendRedirect("connected", "Salesforce connected."));
  } catch (error) {
    response.redirect(getFrontendRedirect("error", getUserMessage(error)));
  }
});

app.get("/api/salesforce/status", async (_request, response) => {
  const token = await readJson(TOKEN_PATH);

  response.json({
    connected: Boolean(token?.refresh_token || token?.access_token),
    instanceUrl: token?.instance_url || null,
  });
});

app.post("/api/salesforce/logout", async (_request, response) => {
  await safeUnlink(TOKEN_PATH);
  response.json({ connected: false });
});

app.post("/api/salesforce/refresh-report", async (_request, response) => {
  try {
    const config = getSalesforceConfig();
    const token = await getUsableToken(config);
    const report = await fetchReportWithRetry(config, token);
    const csv = convertReportToCsv(report);

    response.json({
      csv,
      rowCount: countReportRows(report),
      reportName: report?.attributes?.reportName || report?.reportMetadata?.name || "Salesforce Report",
    });
  } catch (error) {
    response.status(getHttpStatus(error)).json({
      error: getUserMessage(error),
    });
  }
});

app.listen(port, () => {
  console.log(`RouteFlow Salesforce server listening on http://localhost:${port}`);
});

function getSalesforceConfig() {
  const config = {
    clientId: process.env.SALESFORCE_CLIENT_ID,
    clientSecret: process.env.SALESFORCE_CLIENT_SECRET,
    redirectUri: process.env.SALESFORCE_REDIRECT_URI,
    loginUrl: process.env.SALESFORCE_LOGIN_URL || "https://login.salesforce.com",
    reportId: process.env.SALESFORCE_REPORT_ID,
    apiVersion: process.env.SALESFORCE_API_VERSION || "v61.0",
  };
  const missingKeys = Object.entries(config)
    .filter(([key, value]) => key !== "loginUrl" && key !== "apiVersion" && !value)
    .map(([key]) => key);

  if (missingKeys.length) {
    throw Object.assign(new Error(`Missing Salesforce environment values: ${missingKeys.join(", ")}`), {
      code: "CONFIG_ERROR",
      status: 500,
    });
  }

  return config;
}

async function exchangeAuthorizationCode(config, code) {
  if (!code) {
    throw new Error("Salesforce did not return an authorization code.");
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
  });

  return requestSalesforceToken(config, body);
}

async function refreshAccessToken(config, token) {
  if (!token?.refresh_token) {
    throw Object.assign(new Error("Salesforce session expired. Please connect Salesforce again."), {
      code: "AUTH_REQUIRED",
      status: 401,
    });
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: token.refresh_token,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });
  const refreshedToken = await requestSalesforceToken(config, body);
  const nextToken = {
    ...token,
    ...refreshedToken,
    refresh_token: refreshedToken.refresh_token || token.refresh_token,
    savedAt: new Date().toISOString(),
  };

  await writeJson(TOKEN_PATH, nextToken);
  return nextToken;
}

async function requestSalesforceToken(config, body) {
  const response = await fetch(new URL("/services/oauth2/token", config.loginUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw Object.assign(new Error(payload.error_description || payload.error || "Salesforce authentication failed."), {
      code: "SALESFORCE_AUTH_ERROR",
      status: response.status,
    });
  }

  return payload;
}

async function getUsableToken(config) {
  const token = await readJson(TOKEN_PATH);

  if (!token?.access_token) {
    throw Object.assign(new Error("Salesforce is not connected. Please connect Salesforce first."), {
      code: "AUTH_REQUIRED",
      status: 401,
    });
  }

  if (!token.instance_url) {
    return refreshAccessToken(config, token);
  }

  return token;
}

async function fetchReportWithRetry(config, token) {
  try {
    return await fetchReport(config, token);
  } catch (error) {
    if (error.status !== 401) {
      throw error;
    }

    const refreshedToken = await refreshAccessToken(config, token);
    return fetchReport(config, refreshedToken);
  }
}

async function fetchReport(config, token) {
  const reportUrl = new URL(
    `/services/data/${config.apiVersion}/analytics/reports/${config.reportId}`,
    token.instance_url,
  );
  reportUrl.searchParams.set("includeDetails", "true");

  const response = await fetch(reportUrl, {
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      Accept: "application/json",
    },
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw Object.assign(new Error(getSalesforceApiErrorMessage(response.status, payload)), {
      code: "SALESFORCE_API_ERROR",
      status: response.status,
    });
  }

  return payload;
}

function convertReportToCsv(report) {
  const columns = report?.reportMetadata?.detailColumns || [];
  const rows = getReportRows(report);

  if (!columns.length) {
    throw Object.assign(new Error("The Salesforce report did not include detail columns."), {
      code: "REPORT_FORMAT_ERROR",
      status: 422,
    });
  }

  if (!rows.length) {
    return `${columns.map((column) => escapeCsvValue(getColumnLabel(report, column))).join(",")}\n`;
  }

  const header = columns.map((column) => getColumnLabel(report, column));
  const body = rows.map((row) =>
    columns
      .map((_column, index) => {
        const cell = row.dataCells?.[index];
        return escapeCsvValue(cell?.label ?? cell?.value ?? "");
      })
      .join(","),
  );

  return [header.map(escapeCsvValue).join(","), ...body].join("\n");
}

function getReportRows(report) {
  const factMap = report?.factMap || {};
  const directRows = factMap["T!T"]?.rows;

  if (Array.isArray(directRows)) {
    return directRows;
  }

  return Object.values(factMap).flatMap((fact) => (Array.isArray(fact?.rows) ? fact.rows : []));
}

function countReportRows(report) {
  return getReportRows(report).length;
}

function getColumnLabel(report, column) {
  return report?.reportExtendedMetadata?.detailColumnInfo?.[column]?.label || column;
}

function escapeCsvValue(value) {
  const text = String(value ?? "");

  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

function getSalesforceApiErrorMessage(status, payload) {
  const errors = Array.isArray(payload) ? payload : payload?.errors || [payload];
  const message = errors
    .map((error) => error?.message || error?.error_description || error?.errorCode)
    .filter(Boolean)
    .join(" ");

  if (status === 401) {
    return "Salesforce authentication expired or was revoked. Please connect Salesforce again.";
  }

  if (status === 403) {
    return "Salesforce refused access to the report or API. Salesforce admin approval may be required for API access, Connected App access, report visibility, or Run Reports/View Reports permissions.";
  }

  if (status === 404) {
    return "Salesforce report was not found. Check SALESFORCE_REPORT_ID and your report access.";
  }

  return message || "Salesforce report fetch failed.";
}

function getUserMessage(error) {
  if (error?.code === "CONFIG_ERROR") {
    return `${error.message}. Check your .env file.`;
  }

  if (error?.code === "SALESFORCE_AUTH_ERROR") {
    return `${error.message} Salesforce admin approval may be required for Connected App or API access.`;
  }

  return error?.message || "Unexpected Salesforce error.";
}

function getHttpStatus(error) {
  return Number.isInteger(error?.status) ? error.status : 500;
}

function getFrontendRedirect(type, message) {
  const url = new URL(frontendUrl);
  url.searchParams.set(type === "connected" ? "salesforce" : "salesforceError", message);
  return url.toString();
}

function renderCallbackPage(title, message) {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
  <body>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
    <p><a href="${escapeHtml(frontendUrl)}">Return to RouteFlow</a></p>
  </body>
</html>`;
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function safeUnlink(filePath) {
  try {
    await fs.unlink(filePath);
  } catch {}
}

async function loadEnvFile(filePath) {
  let content = "";

  try {
    content = await fs.readFile(filePath, "utf8");
  } catch {
    return;
  }

  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);

    if (!match || match[1].startsWith("#")) {
      continue;
    }

    const [, key, rawValue] = match;

    if (process.env[key]) {
      continue;
    }

    process.env[key] = rawValue.replace(/^["']|["']$/g, "");
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
