import { google } from "googleapis";

const SPREADSHEET_ID = "1E883zDPF-9lPF5u3VoxmwrSN0tipoEFS9rDNDQR-5kg";

const SHEET_NAMES = {
  akty: "Акты",
  uz: "УЗ",
  other_errors: "Остальные ошибки",
  internal_errors: "Внутренние ошибки",
};

function getAuth() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT not set");
  const creds = JSON.parse(raw);
  return new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

async function getSheetValues(auth, sheetName) {
  const sheets = google.sheets({ version: "v4", auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: sheetName,
  });
  return res.data.values || [];
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

async function processSheet(auth, sheetKey, fio) {
  const raw = await getSheetValues(auth, SHEET_NAMES[sheetKey]);
  if (!raw.length || raw.length < 2)
    return { success: false, message: "Лист пуст" };

  const headers = raw[0];
  const parser = PARSERS[sheetKey];
  const colIndices = {};
  for (const [k, kw] of Object.entries(parser.cols)) {
    colIndices[k] = findCol(headers, ...kw);
  }

  const fioNorm = fio
    ? fio
        .toLowerCase()
        .replace(/  +/g, " ")
        .trim()
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

async function getAllFios(auth) {
  const allFios = new Set();
  for (const sheetKey of Object.values(SHEET_NAMES)) {
    try {
      const raw = await getSheetValues(auth, sheetKey);
      if (raw.length < 2) continue;
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
    } catch {
      /* skip */
    }
  }
  return [...allFios].sort();
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
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
  const path = url.pathname.replace(/^\/api\/?/, "");

  try {
    const auth = getAuth();

    if (path === "fios") {
      const fios = await getAllFios(auth);
      return json({ success: true, fios });
    }

    if (path === "test") {
      const raw = await getSheetValues(auth, SHEET_NAMES.akty);
      return json({
        success: true,
        title: "Google Sheet",
        sheets: Object.values(SHEET_NAMES),
      });
    }

    if (path.startsWith("errors/")) {
      const fio = decodeURIComponent(path.slice(7));
      const [akty, internal, uz, other] = await Promise.all([
        processSheet(auth, "akty", fio),
        processSheet(auth, "internal_errors", fio),
        processSheet(auth, "uz", fio),
        processSheet(auth, "other_errors", fio),
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

export const config = {
  path: "/api/*",
};
