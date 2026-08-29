const SPREADSHEET_ID = "1E883zDPF-9lPF5u3VoxmwrSN0tipoEFS9rDNDQR-5kg";

const SHEET_NAMES = {
  akty: "Акты",
  uz: "УЗ",
  other_errors: "Остальные ошибки",
  internal_errors: "Внутренние ошибки",
  users: "Users",
};

const USERS_HEADERS = ["uid", "email", "firstName", "lastName", "role", "status", "assignedFio", "createdAt"];

// Module-scope caches — survive across warm (reused) isolate invocations.
const TOKEN_TTL_MS = 55 * 60 * 1000;
const SHEET_TTL_MS = 45 * 1000;

let cachedToken = null;
let cachedTokenExpiry = 0;
const sheetCache = new Map();

function base64urlFromBytes(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlFromString(str) {
  return base64urlFromBytes(new TextEncoder().encode(str));
}

function pemToArrayBuffer(pem) {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function getAccessToken(env) {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiry) {
    return cachedToken;
  }

  const b64 = (env.GOOGLE_SERVICE_ACCOUNT_B64 || "").trim().replace(/^["']|["']$/g, "").trim();
  if (!b64) throw new Error("GOOGLE_SERVICE_ACCOUNT_B64 not set");
  const raw = atob(b64);
  const creds = JSON.parse(raw);

  const nowSec = Math.floor(now / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: creds.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: nowSec,
    exp: nowSec + 3600,
  };

  const toSign = `${base64urlFromString(JSON.stringify(header))}.${base64urlFromString(JSON.stringify(payload))}`;

  const keyData = pemToArrayBuffer(creds.private_key);
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(toSign));
  const signature = base64urlFromBytes(new Uint8Array(sigBuffer));

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
  cachedToken = data.access_token;
  cachedTokenExpiry = now + TOKEN_TTL_MS;
  return cachedToken;
}

async function getSheetValues(token, sheetName) {
  const now = Date.now();
  const cached = sheetCache.get(sheetName);
  if (cached && now < cached.expiry) {
    return cached.values;
  }

  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(sheetName)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Sheets API error (${sheetName}): ${err}`);
  }
  const data = await res.json();
  const values = data.values || [];
  sheetCache.set(sheetName, { values, expiry: now + SHEET_TTL_MS });
  return values;
}

function invalidateSheetCache(sheetName) {
  sheetCache.delete(sheetName);
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
  invalidateSheetCache(sheetName);
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
  invalidateSheetCache(sheetName);
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
  return dates.length === 1 ? fmt(dates[0]) : `${fmt(dates[0])} — ${fmt(dates[dates.length - 1])}`;
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
  if (!raw.length || raw.length < 2) return { success: false, message: "Лист пуст" };

  const headers = raw[0];
  const parser = PARSERS[sheetKey];
  const colIndices = {};
  for (const [k, kw] of Object.entries(parser.cols)) {
    colIndices[k] = findCol(headers, ...kw);
  }

  const fioNorm = fio ? fio.toLowerCase().replace(/  +/g, " ").trim() : null;

  const records = [];
  for (const row of raw.slice(1)) {
    if (fioNorm && colIndices.fio !== -1) {
      const rowFio = safe(row, colIndices.fio).toLowerCase().replace(/  +/g, " ");
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
      .map((sheetName) => getSheetValues(token, sheetName).catch(() => []))
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

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/?/, "");

  const uid = request.headers.get("x-user-uid") || "";
  const email = request.headers.get("x-user-email") || "";

  try {
    const token = await getAccessToken(env);

    if (path === "fios") {
      const fios = await getAllFios(token);
      return json({ success: true, fios });
    }

    if (path === "me" && uid) {
      const user = await getCurrentUser(token, uid, email);
      if (!user) return json({ success: false, message: "Пользователь не найден" }, 404);
      return json({ success: true, user });
    }

    if (path === "register" && request.method === "POST") {
      const body = await request.json();
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
        fullName, now,
      ]);
      return json({ success: true, message: "Заявка отправлена" });
    }

    if (path.startsWith("errors/")) {
      let fio = decodeURIComponent(path.slice(7));

      if (uid) {
        const user = await getCurrentUser(token, uid, email);
        if (!user || user.status !== "active") {
          return json({ success: false, message: "Доступ запрещён" }, 403);
        }
        if (user.role === "user") {
          const userFio = user.assignedFio || user.firstName;
          if (!userFio) {
            return json({ success: false, message: "Ваше ФИО не найдено. Обратитесь к администратору." }, 403);
          }
          fio = userFio;
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
        period = allDates.length === 1 ? fmt(allDates[0]) : `${fmt(allDates[0])} — ${fmt(allDates[allDates.length - 1])}`;
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

    if (path === "admin/approve" && request.method === "POST") {
      if (!uid) return json({ success: false, message: "Не авторизован" }, 401);
      const admin = await getCurrentUser(token, uid, email);
      if (!admin || !["admin", "superadmin"].includes(admin.role) || admin.status !== "active") {
        return json({ success: false, message: "Доступ запрещён" }, 403);
      }
      const body = await request.json();
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

    if (path === "admin/reject" && request.method === "POST") {
      if (!uid) return json({ success: false, message: "Не авторизован" }, 401);
      const admin = await getCurrentUser(token, uid, email);
      if (!admin || !["admin", "superadmin"].includes(admin.role) || admin.status !== "active") {
        return json({ success: false, message: "Доступ запрещён" }, 403);
      }
      const body = await request.json();
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

    if (path === "admin/make-admin" && request.method === "POST") {
      if (!uid) return json({ success: false, message: "Не авторизован" }, 401);
      const admin = await getCurrentUser(token, uid, email);
      if (!admin || admin.role !== "superadmin" || admin.status !== "active") {
        return json({ success: false, message: "Только суперадмин может назначать админов" }, 403);
      }
      const body = await request.json();
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

    if (path === "admin/update-user" && request.method === "POST") {
      if (!uid) return json({ success: false, message: "Не авторизован" }, 401);
      const admin = await getCurrentUser(token, uid, email);
      if (!admin || !["admin", "superadmin"].includes(admin.role) || admin.status !== "active") {
        return json({ success: false, message: "Доступ запрещён" }, 403);
      }
      const body = await request.json();
      const { targetUid, newFio, newRole } = body;
      if (!targetUid) return json({ success: false, message: "targetUid обязателен" }, 400);
      const targetRowIndex = await findUserRowIndex(token, targetUid);
      if (targetRowIndex === -1) return json({ success: false, message: "Пользователь не найден" }, 404);

      if (newRole && !["user", "admin", "superadmin"].includes(newRole)) {
        return json({ success: false, message: "Недопустимая роль" }, 400);
      }
      if (newRole === "superadmin" && admin.role !== "superadmin") {
        return json({ success: false, message: "Только суперадмин может назначать суперадминов" }, 403);
      }

      const raw = await getSheetValues(token, SHEET_NAMES.users);
      const targetRow = raw[targetRowIndex - 1];
      const row = [
        targetRow[0], targetRow[1],
        newFio !== undefined ? newFio : targetRow[2],
        targetRow[3],
        newRole || targetRow[4],
        targetRow[5],
        newFio !== undefined ? newFio : (targetRow[6] || ""),
        targetRow[7] || new Date().toISOString(),
      ];
      await updateSheetRow(token, SHEET_NAMES.users, targetRowIndex, row);
      return json({ success: true, message: "Пользователь обновлён" });
    }

    if (path === "me/update" && request.method === "POST") {
      if (!uid) return json({ success: false, message: "Не авторизован" }, 401);
      const user = await getCurrentUser(token, uid, email);
      if (!user || user.status !== "active") {
        return json({ success: false, message: "Доступ запрещён" }, 403);
      }
      const body = await request.json();
      const { newFio } = body;
      if (!newFio || !newFio.trim()) {
        return json({ success: false, message: "ФИО обязательно" }, 400);
      }

      const raw = await getSheetValues(token, SHEET_NAMES.users);
      const row = raw[user.rowIndex - 1];
      const updatedRow = [
        row[0], row[1], newFio.trim(), row[3], row[4], row[5], newFio.trim(), row[7] || new Date().toISOString(),
      ];
      await updateSheetRow(token, SHEET_NAMES.users, user.rowIndex, updatedRow);
      return json({ success: true, message: "ФИО обновлено" });
    }

    return json({ error: "Not found" }, 404);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}
