const SPREADSHEET_ID = "1E883zDPF-9lPF5u3VoxmwrSN0tipoEFS9rDNDQR-5kg";

const SHEET_NAMES = {
  akty: "Акты",
  uz: "УЗ",
  other_errors: "Остальные ошибки",
  internal_errors: "Внутренние ошибки",
};

async function getAccessToken() {
  const b64 = (process.env.GOOGLE_SERVICE_ACCOUNT_B64 || "").replace(/^["']|["']$/g, "");
  if (!b64) throw new Error("GOOGLE_SERVICE_ACCOUNT_B64 not set, len=" + (process.env.GOOGLE_SERVICE_ACCOUNT_B64||"").length);
  const raw = Buffer.from(b64, "base64").toString("utf8");
  const creds = JSON.parse(raw);

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: creds.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const enc = (obj) => btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const toSign = `${enc(header)}.${enc(payload)}`;

  const key = creds.private_key;
  const crypto = await import("node:crypto");
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(toSign);
  sign.end();
  const signature = sign.sign(key, "base64url");

  const jwt = `${toSign}.${signature}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token error: ${err}`);
  }

  const data = await res.json();
  return data.access_token;
}

async function getSheetValues(token, sheetName) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(sheetName)}?key=none`;
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(sheetName)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Sheets API error (${sheetName}): ${err}`);
  }
  const data = await res.json();
  return data.values || [];
}

function findCol(headers, ...keywords) {
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i].toLowerCase().trim();
    if (keywords.every((k) => h.includes(k))) return i;
  }
  return -1;
}

function safe(row, i) {
  return i === -1 || i >= row.length ? "" : String(row[i]).trim();
}

function calcPeriod(records) {
  const dates = [];
  for (const rec of records) {
    const m = rec.date && rec.date.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (m) dates.push(new Date(+m[3], +m[2] - 1, +m[1]));
  }
  if (!dates.length) return "Нет данных";
  dates.sort((a, b) => a - b);
  const fmt = (d) =>
    `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;
  return dates.length === 1
    ? fmt(dates[0])
    : `${fmt(dates[0])} — ${fmt(dates[dates.length - 1])}`;
}

const PARSERS = {
  akty: {
    cols: {
      date: ["дата", "ошибк"],
      fio: ["фио", "виновн"],
      reason: ["причин", "ошибк"],
      application: ["приложение"],
      penalty: ["штрафн", "балл"],
      oro_comments: ["комментар", "оро"],
      details: ["детально"],
    },
  },
  internal_errors: {
    cols: {
      date: ["дата", "ошибк"],
      fio: ["фио", "сотрудн"],
      reason: ["причина"],
      department: ["отдел"],
      product: ["товар"],
      comment: ["комментар"],
      application: ["приложение"],
      penalty: ["сумма", "штраф"],
    },
  },
  uz: {
    cols: {
      fio: ["фио", "виновн"],
      oro_comments: ["комментар", "оро"],
      details: ["детально"],
      penalty: ["штрафн", "балл"],
      application: ["приложение"],
      product: ["товар"],
      date: ["дата", "факт"],
    },
  },
  other_errors: {
    cols: {
      date: ["дата", "ошибк"],
      reason: ["причин", "ошибк"],
      product: ["товар", "наименован"],
      details: ["детально"],
      fio: ["фио", "виновн"],
      penalty: ["штрафн", "балл"],
      application: ["приложение"],
    },
  },
};

async function processSheet(token, sheetKey, fio) {
  const raw = await getSheetValues(token, SHEET_NAMES[sheetKey]);
  if (!raw.length || raw.length < 2)
    return { success: false, message: "Лист пуст" };

  const headers = raw[0];
  const parser = PARSERS[sheetKey];
  const colIndices = {};
  for (const [k, kw] of Object.entries(parser.cols)) {
    colIndices[k] = findCol(headers, ...kw);
  }

  const fioNorm = fio
    ? fio.toLowerCase().replace(/  +/g, " ").trim()
    : null;

  const records = [];
  for (const row of raw.slice(1)) {
    if (fioNorm && colIndices.fio !== -1) {
      const rowFio = safe(row, colIndices.fio)
        .toLowerCase()
        .replace(/  +/g, " ");
      if (rowFio !== fioNorm) continue;
    }
    const rec = {};
    for (const [k, v] of Object.entries(colIndices)) {
      rec[k] = safe(row, v);
    }
    records.push(rec);
  }

  return {
    success: true,
    sheet: SHEET_NAMES[sheetKey],
    count: records.length,
    period: calcPeriod(records),
    data: records,
  };
}

async function getAllFios(token) {
  const results = await Promise.all(
    Object.values(SHEET_NAMES).map((sheetName) =>
      getSheetValues(token, sheetName).catch(() => [])
    )
  );

  const allFios = new Set();
  for (const raw of results) {
    if (!raw.length || raw.length < 2) continue;
    const headers = raw[0];
    let fioCol = -1;
    for (let i = 0; i < headers.length; i++) {
      if (headers[i].toLowerCase().includes("фио")) {
        fioCol = i;
        break;
      }
    }
    if (fioCol === -1) continue;
    for (const row of raw.slice(1)) {
      const val = safe(row, fioCol);
      if (val) allFios.add(val);
    }
  }
  return [...allFios].sort();
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

export default async function handler(req) {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  const url = new URL(req.url);
  let path = url.pathname;
  // Strip function prefix if present
  const fnMatch = path.match(/\/\.netlify\/functions\/api\/?(.*)/);
  if (fnMatch) path = fnMatch[1];
  else path = path.replace(/^\/api\/?/, "");

  try {
    const token = await getAccessToken();

    if (path === "fios") {
      const fios = await getAllFios(token);
      return json({ success: true, fios });
    }

    if (path.startsWith("errors/")) {
      const fio = decodeURIComponent(path.slice(7));
      const [akty, internal, uz, other] = await Promise.all([
        processSheet(token, "akty", fio),
        processSheet(token, "internal_errors", fio),
        processSheet(token, "uz", fio),
        processSheet(token, "other_errors", fio),
      ]);

      let totalRecords = 0;
      let totalPenalty = 0;
      const allDates = [];

      for (const result of [akty, internal, uz, other]) {
        if (!result.success || !result.data) continue;
        totalRecords += result.count;
        for (const rec of result.data) {
          const p = parseFloat(String(rec.penalty || "0").replace(",", "."));
          if (!isNaN(p)) totalPenalty += p;
          const m = (rec.date || "").match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
          if (m) allDates.push(new Date(+m[3], +m[2] - 1, +m[1]));
        }
      }

      let period = "Нет данных";
      if (allDates.length) {
        allDates.sort((a, b) => a - b);
        const fmt = (d) =>
          `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;
        period =
          allDates.length === 1
            ? fmt(allDates[0])
            : `${fmt(allDates[0])} — ${fmt(allDates[allDates.length - 1])}`;
      }

      return json({
        success: true,
        fio,
        period,
        total_records: totalRecords,
        total_penalty: Math.round(totalPenalty * 10) / 10,
        akty,
        internal,
        uz,
        other,
      });
    }

    return json({ error: "Not found" }, 404);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}
