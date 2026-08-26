const SPREADSHEET_ID = "1E883zDPF-9lPF5u3VoxmwrSN0tipoEFS9rDNDQR-5kg";

const SHEET_NAMES = {
  akty: "Акты",
  uz: "УЗ",
  other_errors: "Остальные ошибки",
  internal_errors: "Внутренние ошибки",
  users: "Users",
};

const USERS_HEADERS = ["uid", "email", "firstName", "lastName", "role", "status", "assignedFio", "createdAt"];

async function getAccessToken() {
  const b64 = (process.env.GOOGLE_SERVICE_ACCOUNT_B64 || "").replace(/^["']|["']$/g, "");
  if (!b64) throw new Error("GOOGLE_SERVICE_ACCOUNT_B64 not set");
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

async function appendSheetRow(token, sheetName, values) {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(sheetName)}:append?valueInputOption=USER_ENTERED`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [values] }),
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Sheets append error (${sheetName}): ${err}`);
  }
  return res.json();
}

async function updateSheetRow(token, sheetName, rowIndex, values) {
  const range = `${sheetName}!A${rowIndex}`;
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [values] }),
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Sheets update error (${sheetName}): ${err}`);
  }
  return res.json();
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
    Object.values(SHEET_NAMES)
      .filter((n) => n !== "Users")
      .map((sheetName) =>
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

async function getUsers(token) {
  const raw = await getSheetValues(token, SHEET_NAMES.users);
  if (!raw.length || raw.length < 2) return [];

  const headers = raw[0].map((h) => h.toLowerCase().trim());
  const users = [];
  for (let i = 1; i < raw.length; i++) {
    const row = raw[i];
    const user = {};
    for (let j = 0; j < USERS_HEADERS.length; j++) {
      user[USERS_HEADERS[j]] = j < row.length ? String(row[j]).trim() : "";
    }
    user.rowIndex = i + 1;
    users.push(user);
  }
  return users;
}

async function findUserRowIndex(token, uid) {
  const raw = await getSheetValues(token, SHEET_NAMES.users);
  if (!raw.length) return -1;

  for (let i = 1; i < raw.length; i++) {
    if (raw[i][0] === uid) return i + 1;
  }
  return -1;
}

async function findUserByEmail(token, email) {
  const raw = await getSheetValues(token, SHEET_NAMES.users);
  if (!raw.length) return null;

  for (let i = 1; i < raw.length; i++) {
    if (raw[i][1] && raw[i][1].toLowerCase() === email.toLowerCase()) {
      const user = {};
      for (let j = 0; j < USERS_HEADERS.length; j++) {
        user[USERS_HEADERS[j]] = j < raw[i].length ? String(raw[i][j]).trim() : "";
      }
      user.rowIndex = i + 1;
      return user;
    }
  }
  return null;
}

async function getCurrentUser(token, uid, email) {
  const raw = await getSheetValues(token, SHEET_NAMES.users);
  if (!raw.length) return null;

  for (let i = 1; i < raw.length; i++) {
    if (raw[i][0] === uid) {
      const user = {};
      for (let j = 0; j < USERS_HEADERS.length; j++) {
        user[USERS_HEADERS[j]] = j < raw[i].length ? String(raw[i][j]).trim() : "";
      }
      user.rowIndex = i + 1;
      return user;
    }
  }

  if (email) {
    for (let i = 1; i < raw.length; i++) {
      if (raw[i][1] && raw[i][1].toLowerCase() === email.toLowerCase()) {
        const user = {};
        for (let j = 0; j < USERS_HEADERS.length; j++) {
          user[USERS_HEADERS[j]] = j < raw[i].length ? String(raw[i][j]).trim() : "";
        }
        user.rowIndex = i + 1;

        if (user.uid !== uid) {
          raw[i][0] = uid;
          const row = raw[i].slice(0, USERS_HEADERS.length);
          await updateSheetRow(token, SHEET_NAMES.users, user.rowIndex, row);
          user.uid = uid;
        }

        return user;
      }
    }
  }

  return null;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-User-Uid, X-User-Email",
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
    return new Response(null, { headers: CORS_HEADERS });
  }

  const url = new URL(req.url);
  let path = url.pathname;
  const fnMatch = path.match(/\/\.netlify\/functions\/api\/?(.*)/);
  if (fnMatch) path = fnMatch[1];
  else path = path.replace(/^\/api\/?/, "");

  const uid = req.headers.get("x-user-uid") || "";
  const email = req.headers.get("x-user-email") || "";

  try {
    const token = await getAccessToken();

    if (path === "fios") {
      const fios = await getAllFios(token);
      return json({ success: true, fios });
    }

    if (path === "me" && uid) {
      const user = await getCurrentUser(token, uid, email);
      if (!user) return json({ success: false, message: "Пользователь не найден" }, 404);
      return json({ success: true, user });
    }

    if (path === "register" && req.method === "POST") {
      const body = await req.json();
      const { uid: regUid, email: regEmail, firstName, middleName, lastName } = body;
      if (!regUid || !regEmail || !firstName || !lastName) {
        return json({ success: false, message: "Все поля обязательны" }, 400);
      }
      const existing = await findUserByEmail(token, regEmail);
      if (existing) {
        return json({ success: false, message: "Пользователь уже зарегистрирован" }, 409);
      }
      const isSuperAdmin = regEmail.toLowerCase() === "barakilllubogo@gmail.com";
      const fullName = [firstName, middleName, lastName].filter(Boolean).join(" ");
      const now = new Date().toISOString();
      await appendSheetRow(token, SHEET_NAMES.users, [
        regUid, regEmail, fullName, "",
        isSuperAdmin ? "superadmin" : "user",
        isSuperAdmin ? "active" : "pending",
        "", now,
      ]);
      return json({ success: true, message: "Заявка отправлена" });
    }

    if (path.startsWith("errors/")) {
      const fio = decodeURIComponent(path.slice(7));

      if (uid) {
        const user = await getCurrentUser(token, uid, email);
        if (!user || user.status !== "active") {
          return json({ success: false, message: "Доступ запрещён" }, 403);
        }
        if (user.role === "user") {
          if (!user.assignedFio) {
            return json({ success: false, message: "Вам не назначено ФИО. Обратитесь к администратору." }, 403);
          }
          if (fio.toLowerCase() !== user.assignedFio.toLowerCase()) {
            return json({ success: false, message: "Вы можете просматривать только свои ошибки" }, 403);
          }
        }
      }

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

    if (path === "admin/users") {
      if (!uid) return json({ success: false, message: "Не авторизован" }, 401);
      const user = await getCurrentUser(token, uid, email);
      if (!user || !["admin", "superadmin"].includes(user.role) || user.status !== "active") {
        return json({ success: false, message: "Доступ запрещён" }, 403);
      }
      const users = await getUsers(token);
      return json({ success: true, users });
    }

    if (path === "admin/approve" && req.method === "POST") {
      if (!uid) return json({ success: false, message: "Не авторизован" }, 401);
      const admin = await getCurrentUser(token, uid, email);
      if (!admin || !["admin", "superadmin"].includes(admin.role) || admin.status !== "active") {
        return json({ success: false, message: "Доступ запрещён" }, 403);
      }
      const body = await req.json();
      const { targetUid, assignedFio } = body;
      if (!targetUid) return json({ success: false, message: "targetUid обязателен" }, 400);
      const targetRowIndex = await findUserRowIndex(token, targetUid);
      if (targetRowIndex === -1) return json({ success: false, message: "Пользователь не найден" }, 404);

      const raw = await getSheetValues(token, SHEET_NAMES.users);
      const targetRow = raw[targetRowIndex - 1];
      const row = [
        targetRow[0], targetRow[1], targetRow[2], targetRow[3],
        "user", "active", assignedFio || targetRow[6] || "", targetRow[7] || new Date().toISOString(),
      ];
      await updateSheetRow(token, SHEET_NAMES.users, targetRowIndex, row);
      return json({ success: true, message: "Пользователь одобрен" });
    }

    if (path === "admin/reject" && req.method === "POST") {
      if (!uid) return json({ success: false, message: "Не авторизован" }, 401);
      const admin = await getCurrentUser(token, uid, email);
      if (!admin || !["admin", "superadmin"].includes(admin.role) || admin.status !== "active") {
        return json({ success: false, message: "Доступ запрещён" }, 403);
      }
      const body = await req.json();
      const { targetUid } = body;
      if (!targetUid) return json({ success: false, message: "targetUid обязателен" }, 400);
      const targetRowIndex = await findUserRowIndex(token, targetUid);
      if (targetRowIndex === -1) return json({ success: false, message: "Пользователь не найден" }, 404);

      const raw = await getSheetValues(token, SHEET_NAMES.users);
      const targetRow = raw[targetRowIndex - 1];
      const row = [
        targetRow[0], targetRow[1], targetRow[2], targetRow[3],
        "user", "rejected", "", targetRow[7] || new Date().toISOString(),
      ];
      await updateSheetRow(token, SHEET_NAMES.users, targetRowIndex, row);
      return json({ success: true, message: "Заявка отклонена" });
    }

    if (path === "admin/make-admin" && req.method === "POST") {
      if (!uid) return json({ success: false, message: "Не авторизован" }, 401);
      const admin = await getCurrentUser(token, uid, email);
      if (!admin || admin.role !== "superadmin" || admin.status !== "active") {
        return json({ success: false, message: "Только суперадмин может назначать админов" }, 403);
      }
      const body = await req.json();
      const { targetUid } = body;
      if (!targetUid) return json({ success: false, message: "targetUid обязателен" }, 400);
      const targetRowIndex = await findUserRowIndex(token, targetUid);
      if (targetRowIndex === -1) return json({ success: false, message: "Пользователь не найден" }, 404);

      const raw = await getSheetValues(token, SHEET_NAMES.users);
      const targetRow = raw[targetRowIndex - 1];
      const row = [
        targetRow[0], targetRow[1], targetRow[2], targetRow[3],
        "admin", "active", targetRow[6] || "", targetRow[7] || new Date().toISOString(),
      ];
      await updateSheetRow(token, SHEET_NAMES.users, targetRowIndex, row);
      return json({ success: true, message: "Пользователь назначен админом" });
    }

    return json({ error: "Not found" }, 404);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}
