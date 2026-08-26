const FIREBASE_CONFIG = {
    apiKey: "AIzaSyB7H82A-fw8uMRRdu71bqBTawEKRiIWlA8",
    authDomain: "check-list-5d9f9.firebaseapp.com",
    projectId: "check-list-5d9f9",
    storageBucket: "check-list-5d9f9.firebasestorage.app",
    messagingSenderId: "191294120106",
    appId: "1:191294120106:web:3033138b2b2484c50730d3",
};

firebase.initializeApp(FIREBASE_CONFIG);
const auth = firebase.auth();

let allFios = [];
let fioIndex = -1;
let currentData = null;
let currentUserProfile = null;
let activeView = "errors";

const screens = ["loading", "login", "register", "pending", "rejected", "app"];

function showScreen(name) {
    screens.forEach((s) => {
        const el = document.getElementById("screen-" + s);
        if (el) el.classList.toggle("hidden", s !== name);
    });
}

function showErr(id, msg) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = msg;
    el.style.display = "block";
}

function hideErr(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
}

function loadingBtn(btn, state) {
    if (!btn) return;
    if (state) {
        btn.disabled = true;
        btn._txt = btn.textContent;
        btn.innerHTML = '<div class="spinner" style="width:18px;height:18px;border-width:2px;margin:0 auto"></div>';
    } else {
        btn.disabled = false;
        btn.textContent = btn._txt || btn.textContent;
    }
}

async function fetchApi(path, opts = {}) {
    const headers = { ...opts.headers };
    if (currentUserProfile) {
        headers["X-User-Uid"] = currentUserProfile.uid;
        headers["X-User-Email"] = currentUserProfile.email;
    }
    const res = await fetch(path, { ...opts, headers });
    return res.json();
}

auth.onAuthStateChanged(async (user) => {
    if (!user) {
        currentUserProfile = null;
        showScreen("login");
        return;
    }

    showScreen("loading");

    try {
        const meRes = await fetch("/api/me", {
            headers: { "X-User-Uid": user.uid, "X-User-Email": user.email || "" },
        });
        const data = await meRes.json();
        if (data.success && data.user) {
            currentUserProfile = { ...data.user, uid: user.uid, email: user.email };
        } else {
            currentUserProfile = {
                uid: user.uid,
                email: user.email,
                firstName: "",
                lastName: "",
                role: "user",
                status: "pending",
                assignedFio: "",
            };
        }
    } catch (e) {
        currentUserProfile = {
            uid: user.uid,
            email: user.email,
            firstName: "",
            lastName: "",
            role: "user",
            status: "pending",
            assignedFio: "",
        };
    }

    const status = currentUserProfile.status;
    if (status === "pending") {
        showScreen("pending");
    } else if (status === "rejected") {
        showScreen("rejected");
    } else if (status === "active") {
        showScreen("app");
        initApp();
    } else {
        showScreen("pending");
    }
});

document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("l-btn").onclick = doLogin;
    document.getElementById("l-pass").addEventListener("keydown", (e) => {
        if (e.key === "Enter") doLogin();
    });
    document.getElementById("to-register").onclick = (e) => {
        e.preventDefault();
        showScreen("register");
    };

    document.getElementById("r-btn").onclick = doRegister;
    document.getElementById("r-pass").addEventListener("keydown", (e) => {
        if (e.key === "Enter") doRegister();
    });
    document.getElementById("to-login").onclick = (e) => {
        e.preventDefault();
        showScreen("login");
    };

    document.getElementById("logout-btn").onclick = () => auth.signOut();
});

async function doLogin() {
    const email = document.getElementById("l-email").value.trim();
    const pass = document.getElementById("l-pass").value;
    const btn = document.getElementById("l-btn");
    hideErr("l-err");
    if (!email || !pass) {
        showErr("l-err", "Заполните все поля");
        return;
    }
    loadingBtn(btn, true);
    try {
        await auth.signInWithEmailAndPassword(email, pass);
    } catch (e) {
        const msg =
            e.code === "auth/wrong-password" || e.code === "auth/user-not-found"
                ? "Неверный email или пароль"
                : "Ошибка входа: " + e.message;
        showErr("l-err", msg);
        loadingBtn(btn, false);
    }
}

async function doRegister() {
    const fn = document.getElementById("r-fn").value.trim();
    const mn = document.getElementById("r-mn").value.trim();
    const ln = document.getElementById("r-ln").value.trim();
    const email = document.getElementById("r-email").value.trim();
    const pass = document.getElementById("r-pass").value;
    const btn = document.getElementById("r-btn");
    hideErr("r-err");
    if (!fn || !mn || !ln || !email || !pass) {
        showErr("r-err", "Заполните все поля");
        return;
    }
    if (pass.length < 6) {
        showErr("r-err", "Пароль минимум 6 символов");
        return;
    }
    loadingBtn(btn, true);
    try {
        const cred = await auth.createUserWithEmailAndPassword(email, pass);
        await fetch("/api/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                uid: cred.user.uid,
                email,
                firstName: fn,
                middleName: mn,
                lastName: ln,
            }),
        });
    } catch (e) {
        const msg =
            e.code === "auth/email-already-in-use"
                ? "Этот email уже зарегистрирован"
                : "Ошибка: " + e.message;
        showErr("r-err", msg);
        loadingBtn(btn, false);
    }
}

function initApp() {
    const nameEl = document.getElementById("user-name");
    const roleEl = document.getElementById("user-role");
    const adminNav = document.getElementById("admin-nav");
    const fullName = currentUserProfile.firstName || currentUserProfile.email;
    nameEl.textContent = fullName || currentUserProfile.email;

    const role = currentUserProfile.role;
    if (role === "superadmin") {
        roleEl.textContent = "Суперадмин";
        roleEl.className = "role-badge role-sa";
        adminNav.classList.remove("hidden");
    } else if (role === "admin") {
        roleEl.textContent = "Админ";
        roleEl.className = "role-badge role-admin";
        adminNav.classList.remove("hidden");
    } else {
        roleEl.textContent = "Сотрудник";
        roleEl.className = "role-badge role-user";
        adminNav.classList.add("hidden");
    }

    activeView = "errors";
    updateView();

    const isUser = currentUserProfile.role === "user";
    const controls = document.querySelector(".controls");
    const userFio = currentUserProfile.assignedFio || currentUserProfile.firstName;

    if (isUser) {
        controls.style.display = "none";
        if (userFio) {
            loadErrorsForFio(userFio);
        }
    } else {
        controls.style.display = "";
    }

    loadFios();
}

async function loadErrorsForFio(fio) {
    document.getElementById("results").classList.add("hidden");
    document.getElementById("loading").classList.remove("hidden");
    hideError();

    try {
        const data = await fetchApi(`/api/errors/${encodeURIComponent(fio)}`);
        if (!data.success) throw new Error(data.message || "Неизвестная ошибка");
        currentData = data;
        renderResults(data);
        document.getElementById("results").classList.remove("hidden");
    } catch (e) {
        showError("Ошибка загрузки: " + e.message);
    } finally {
        document.getElementById("loading").classList.add("hidden");
    }
}

function updateView() {
    const isAdmin = ["admin", "superadmin"].includes(currentUserProfile.role);
    const isUser = currentUserProfile.role === "user";
    const adminPanel = document.getElementById("admin-panel");
    const controls = document.querySelector(".controls");
    const results = document.getElementById("results");
    const loading = document.getElementById("loading");

    if (activeView === "users" && isAdmin) {
        adminPanel.classList.remove("hidden");
        controls.style.display = "none";
        if (results) results.classList.add("hidden");
        if (loading) loading.classList.add("hidden");
        loadUsers();
    } else if (isUser) {
        adminPanel.classList.add("hidden");
        controls.style.display = "none";
    } else {
        adminPanel.classList.add("hidden");
        controls.style.display = "";
    }
}

async function loadFios() {
    try {
        const data = await fetchApi("/api/fios");
        if (data.success) {
            allFios = data.fios;
        }
    } catch (e) {
        console.warn("Не удалось загрузить список ФИО:", e);
    }
}

const input = document.getElementById("fio-input");
const suggestions = document.getElementById("fio-suggestions");

input.addEventListener("input", () => {
    const val = input.value.trim().toLowerCase();
    fioIndex = -1;

    if (val.length < 2) {
        suggestions.classList.add("hidden");
        return;
    }

    const matches = allFios.filter((f) => f.toLowerCase().includes(val)).slice(0, 15);
    if (matches.length === 0) {
        suggestions.classList.add("hidden");
        return;
    }

    suggestions.innerHTML = matches
        .map(
            (f, i) =>
                `<div class="item" data-fio="${escHtml(f)}" onclick="selectFio('${escAttr(f)}')">${escHtml(f)}</div>`
        )
        .join("");
    suggestions.classList.remove("hidden");
});

input.addEventListener("keydown", (e) => {
    const items = suggestions.querySelectorAll(".item");
    if (!items.length) {
        if (e.key === "Enter") loadErrors();
        return;
    }

    if (e.key === "ArrowDown") {
        e.preventDefault();
        fioIndex = Math.min(fioIndex + 1, items.length - 1);
        updateMark(items);
    } else if (e.key === "ArrowUp") {
        e.preventDefault();
        fioIndex = Math.max(fioIndex - 1, 0);
        updateMark(items);
    } else if (e.key === "Enter") {
        e.preventDefault();
        if (fioIndex >= 0 && fioIndex < items.length) {
            selectFio(items[fioIndex].dataset.fio);
        } else {
            loadErrors();
        }
    } else if (e.key === "Escape") {
        suggestions.classList.add("hidden");
    }
});

document.addEventListener("click", (e) => {
    if (!suggestions.contains(e.target) && e.target !== input) {
        suggestions.classList.add("hidden");
    }
});

function updateMark(items) {
    items.forEach((el, i) => el.classList.toggle("marked", i === fioIndex));
}

function selectFio(fio) {
    input.value = fio;
    suggestions.classList.add("hidden");
    loadErrors();
}

async function loadErrors() {
    const fio = input.value.trim();
    if (!fio) {
        showError("Введите ФИО сотрудника");
        return;
    }

    hideError();
    document.getElementById("results").classList.add("hidden");
    document.getElementById("loading").classList.remove("hidden");

    try {
        const data = await fetchApi(`/api/errors/${encodeURIComponent(fio)}`);

        if (!data.success) {
            throw new Error(data.message || "Неизвестная ошибка");
        }

        currentData = data;
        renderResults(data);
        document.getElementById("results").classList.remove("hidden");
    } catch (e) {
        showError("Ошибка загрузки: " + e.message);
    } finally {
        document.getElementById("loading").classList.add("hidden");
    }
}

function renderResults(data) {
    const summary = document.getElementById("summary");
    const totalPenalty =
        data.total_penalty > 0
            ? `<div class="card"><div class="value">${data.total_penalty}</div><div class="label">Штрафные баллы</div></div>`
            : "";

    summary.innerHTML = `
        <div class="card"><div class="value">${data.total_records}</div><div class="label">Всего записей</div></div>
        <div class="card"><div class="value">${escHtml(data.period)}</div><div class="label">Период</div></div>
        ${totalPenalty}
    `;

    renderPanel("panel-akty", data.akty, "Акты", renderAktyCard);
    renderPanel("panel-internal", data.internal, "Внутренние ошибки", renderInternalCard);
    renderPanel("panel-uz", data.uz, "УЗ", renderUzCard);
    renderPanel("panel-other", data.other, "Остальные ошибки", renderOtherCard);

    const tabs = ["akty", "internal", "uz", "other"];
    const counts = [data.akty, data.internal, data.uz, data.other].map((d) => d?.count || 0);

    let first = 0;
    for (let i = 0; i < counts.length; i++) {
        if (counts[i] > 0) {
            first = i;
            break;
        }
    }
    switchTab(tabs[first]);

    document.querySelectorAll(".tab").forEach((t) => {
        const key = t.dataset.tab;
        const idx = tabs.indexOf(key);
        const count = counts[idx];
        t.textContent = `${["Акты", "Внутренние", "УЗ", "Остальные"][idx]} (${count})`;
    });
}

function renderPanel(panelId, result, title, cardRenderer) {
    const el = document.getElementById(panelId);
    if (!result || !result.success || !result.data || result.data.length === 0) {
        el.innerHTML = '<div class="no-data">Нет данных</div>';
        return;
    }
    el.innerHTML = result.data.map((rec, i) => cardRenderer(rec, i + 1)).join("");
}

function renderAktyCard(rec, n) {
    return cardHtml(n, rec.penalty, [
        field("Дата", rec.date),
        field("Причина", rec.reason),
        field("Приложение", rec.application),
        field("Комментарий ОРО", rec.oro_comments, true),
        field("Детали", rec.details, true),
    ]);
}

function renderInternalCard(rec, n) {
    return cardHtml(n, rec.penalty, [
        field("Дата", rec.date),
        field("Причина", rec.reason),
        field("Отдел", rec.department),
        field("Товар", rec.product),
        field("Приложение", rec.application),
        field("Комментарий", rec.comment, true),
    ]);
}

function renderUzCard(rec, n) {
    return cardHtml(n, rec.penalty, [
        field("Дата", rec.date),
        field("Товар", rec.product),
        field("Приложение", rec.application),
        field("Детали ОРО", rec.oro_comments, true),
        field("Детали", rec.details, true),
    ]);
}

function renderOtherCard(rec, n) {
    return cardHtml(n, rec.penalty, [
        field("Дата", rec.date),
        field("Причина", rec.reason),
        field("Товар", rec.product),
        field("Приложение", rec.application),
        field("Детали", rec.details, true),
    ]);
}

function cardHtml(n, penalty, fields) {
    const pVal = parsePenalty(penalty);
    const pClass = pVal > 0 ? "" : " zero";
    const pText = penalty ? penalty : "0";

    const fieldsHtml = fields
        .filter((f) => f.value)
        .map((f) => {
            const cls = f.full ? "field full" : "field";
            return `<div class="${cls}"><span class="field-label">${escHtml(f.label)}:</span><span class="field-value">${escHtml(f.value)}</span></div>`;
        })
        .join("");

    return `
        <div class="error-card">
            <div class="card-header">
                <span class="card-num">#${n}</span>
                <span class="card-penalty${pClass}">${escHtml(pText)}</span>
            </div>
            <div class="fields">${fieldsHtml}</div>
        </div>
    `;
}

function field(label, value, full = false) {
    return { label, value: value || "", full };
}

function parsePenalty(val) {
    if (!val) return 0;
    return parseFloat(String(val).replace(",", ".")) || 0;
}

function switchTab(tab) {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
    document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === "panel-" + tab));
}

function showError(msg) {
    const el = document.getElementById("error-message");
    el.textContent = msg;
    el.classList.remove("hidden");
}

function hideError() {
    document.getElementById("error-message").classList.add("hidden");
}

function escHtml(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
}

function escAttr(s) {
    return s.replace(/'/g, "\\'").replace(/"/g, "&quot;");
}

async function loadUsers() {
    const list = document.getElementById("users-list");
    list.innerHTML = '<div class="spinner" style="margin:30px auto"></div>';

    try {
        const data = await fetchApi("/api/admin/users");
        if (!data.success) throw new Error(data.message);

        const users = data.users;
        const pending = users.filter((u) => u.status === "pending");
        const active = users.filter((u) => u.status === "active");
        const rejected = users.filter((u) => u.status === "rejected");

        let html = "";

        if (pending.length) {
            html += `<h3 style="color:#f59e0b;font-size:0.85rem;font-weight:700;margin:0 0 10px;text-transform:uppercase;letter-spacing:1px">Ожидают одобрения (${pending.length})</h3>`;
            pending.forEach((u) => {
                html += userCard(u, "pending");
            });
        }

        if (active.length) {
            html += `<h3 style="color:#10b981;font-size:0.85rem;font-weight:700;margin:16px 0 10px;text-transform:uppercase;letter-spacing:1px">Активные (${active.length})</h3>`;
            active.forEach((u) => {
                html += userCard(u, "active");
            });
        }

        if (rejected.length) {
            html += `<h3 style="color:#666;font-size:0.85rem;font-weight:700;margin:16px 0 10px;text-transform:uppercase;letter-spacing:1px">Отклонённые (${rejected.length})</h3>`;
            rejected.forEach((u) => {
                html += userCard(u, "rejected");
            });
        }

        if (!users.length) {
            html = '<div class="no-data">Нет пользователей</div>';
        }

        list.innerHTML = html;

        list.querySelectorAll("[data-approve]").forEach((btn) => {
            btn.onclick = () => approveUser(btn.dataset.approve);
        });
        list.querySelectorAll("[data-reject]").forEach((btn) => {
            btn.onclick = () => rejectUser(btn.dataset.reject);
        });
        list.querySelectorAll("[data-makeadmin]").forEach((btn) => {
            btn.onclick = () => makeAdmin(btn.dataset.makeadmin);
        });
        list.querySelectorAll("[data-edit]").forEach((btn) => {
            btn.onclick = () => {
                const data = JSON.parse(btn.dataset.edit);
                showEditModal(data.uid, data.firstName, data.role);
            };
        });
    } catch (e) {
        list.innerHTML = `<div class="error-box">Ошибка загрузки: ${escHtml(e.message)}</div>`;
    }
}

function userCard(u, status) {
    const fullName = u.firstName || u.email;
    const roleLabel = u.role === "superadmin" ? "Суперадмин" : u.role === "admin" ? "Админ" : "Сотрудник";
    const statusBadge =
        status === "pending"
            ? '<span class="status-badge status-pending">Ожидает</span>'
            : status === "active"
            ? '<span class="status-badge status-active">Активен</span>'
            : '<span class="status-badge status-rejected">Отклонён</span>';

    const isSuperadmin = currentUserProfile.role === "superadmin";
    const isAdmin = ["admin", "superadmin"].includes(currentUserProfile.role);

    return `
        <div class="user-card">
            <div class="user-card-info">
                <div class="user-card-name">${escHtml(fullName)} ${statusBadge}</div>
                <div class="user-card-meta">${escHtml(u.email)} · ${roleLabel}</div>
                ${u.assignedFio ? `<div class="user-card-fio">ФИО для поиска: ${escHtml(u.assignedFio)}</div>` : ""}
            </div>
            <div class="user-card-actions">
                ${
                    status === "pending"
                        ? `<button class="btn btn-sm btn-approve" data-approve="${escAttr(u.uid)}">Одобрить</button>
                           <button class="btn btn-sm btn-reject-card" data-reject="${escAttr(u.uid)}">Отклонить</button>`
                        : ""
                }
                ${
                    status === "active" && isAdmin
                        ? `<button class="btn btn-sm btn-edit" data-edit='${escAttr(JSON.stringify({uid:u.uid, firstName:u.firstName, role:u.role}))}'>Изменить</button>`
                        : ""
                }
                ${
                    status === "active" && u.role === "user" && isSuperadmin
                        ? `<button class="btn btn-sm btn-makeadmin" data-makeadmin="${escAttr(u.uid)}">Сделать админом</button>`
                        : ""
                }
            </div>
        </div>
    `;
}

async function approveUser(targetUid) {
    const fio = prompt("Введите ФИО сотрудника из таблицы (точное совпадение):");
    if (fio === null) return;
    if (!fio.trim()) {
        alert("ФИО обязательно для одобрения");
        return;
    }
    try {
        const data = await fetchApi("/api/admin/approve", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ targetUid, assignedFio: fio.trim() }),
        });
        if (!data.success) throw new Error(data.message);
        loadUsers();
    } catch (e) {
        alert("Ошибка: " + e.message);
    }
}

async function rejectUser(targetUid) {
    if (!confirm("Отклонить заявку?")) return;
    try {
        const data = await fetchApi("/api/admin/reject", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ targetUid }),
        });
        if (!data.success) throw new Error(data.message);
        loadUsers();
    } catch (e) {
        alert("Ошибка: " + e.message);
    }
}

async function makeAdmin(targetUid) {
    if (!confirm("Назначить пользователя админом?")) return;
    try {
        const data = await fetchApi("/api/admin/make-admin", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ targetUid }),
        });
        if (!data.success) throw new Error(data.message);
        loadUsers();
    } catch (e) {
        alert("Ошибка: " + e.message);
    }
}

window.showView = function (view) {
    activeView = view;
    document.querySelectorAll(".admin-tab").forEach((t) => {
        t.classList.toggle("active", t.dataset.view === view);
    });
    updateView();
};

function showEditModal(targetUid, currentName, currentRole) {
    const existing = document.getElementById("modal-overlay");
    if (existing) existing.remove();

    const isSuperadmin = currentUserProfile.role === "superadmin";
    const roleOptions = isSuperadmin
        ? `<option value="user" ${currentRole==="user"?"selected":""}>Сотрудник</option>
           <option value="admin" ${currentRole==="admin"?"selected":""}>Админ</option>
           <option value="superadmin" ${currentRole==="superadmin"?"selected":""}>Суперадмин</option>`
        : `<option value="user" ${currentRole==="user"?"selected":""}>Сотрудник</option>
           <option value="admin" ${currentRole==="admin"?"selected":""}>Админ</option>`;

    const ov = document.createElement("div");
    ov.id = "modal-overlay";
    ov.className = "modal-overlay";
    ov.innerHTML = `
        <div class="modal-sheet">
            <div class="modal-handle"></div>
            <h3 style="font-size:1rem;font-weight:700;margin:0 0 16px;color:#fff">Редактировать пользователя</h3>
            <div class="field"><label>ФИО</label><input id="modal-fio" type="text" value="${escAttr(currentName || "")}" placeholder="Имя Отчество Фамилия"></div>
            <div class="field"><label>Роль</label><select id="modal-role">${roleOptions}</select></div>
            <div style="display:flex;gap:10px;margin-top:16px">
                <button id="modal-save" class="btn btn-accent" style="flex:1">Сохранить</button>
                <button id="modal-cancel" class="btn btn-ghost" style="flex:1">Отмена</button>
            </div>
        </div>`;
    ov.onclick = (e) => { if (e.target === ov) ov.remove(); };
    document.body.appendChild(ov);

    document.getElementById("modal-cancel").onclick = () => ov.remove();
    document.getElementById("modal-save").onclick = async () => {
        const newFio = document.getElementById("modal-fio").value.trim();
        const newRole = document.getElementById("modal-role").value;
        if (!newFio) { alert("Введите ФИО"); return; }
        try {
            const data = await fetchApi("/api/admin/update-user", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ targetUid, newFio, newRole }),
            });
            if (!data.success) throw new Error(data.message);
            ov.remove();
            loadUsers();
        } catch (e) {
            alert("Ошибка: " + e.message);
        }
    };
}

function showRenameModal() {
    const existing = document.getElementById("modal-overlay");
    if (existing) existing.remove();

    const currentName = currentUserProfile.firstName || "";
    const ov = document.createElement("div");
    ov.id = "modal-overlay";
    ov.className = "modal-overlay";
    ov.innerHTML = `
        <div class="modal-sheet">
            <div class="modal-handle"></div>
            <h3 style="font-size:1rem;font-weight:700;margin:0 0 6px;color:#fff">Изменить ФИО</h3>
            <p style="color:#666;font-size:0.8rem;margin:0 0 16px">ФИО используется для поиска ошибок в таблице</p>
            <div class="field"><label>ФИО</label><input id="modal-fio" type="text" value="${escAttr(currentName)}" placeholder="Имя Отчество Фамилия"></div>
            <div style="display:flex;gap:10px;margin-top:16px">
                <button id="modal-save" class="btn btn-accent" style="flex:1">Сохранить</button>
                <button id="modal-cancel" class="btn btn-ghost" style="flex:1">Отмена</button>
            </div>
        </div>`;
    ov.onclick = (e) => { if (e.target === ov) ov.remove(); };
    document.body.appendChild(ov);

    document.getElementById("modal-cancel").onclick = () => ov.remove();
    document.getElementById("modal-save").onclick = async () => {
        const newFio = document.getElementById("modal-fio").value.trim();
        if (!newFio) { alert("Введите ФИО"); return; }
        try {
            const data = await fetchApi("/api/me/update", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ newFio }),
            });
            if (!data.success) throw new Error(data.message);
            currentUserProfile.firstName = newFio;
            currentUserProfile.assignedFio = newFio;
            document.getElementById("user-name").textContent = newFio;
            ov.remove();
            loadErrorsForFio(newFio);
        } catch (e) {
            alert("Ошибка: " + e.message);
        }
    };
}
