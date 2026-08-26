let allFios = [];
let fioIndex = -1;
let currentData = null;

document.addEventListener('DOMContentLoaded', async () => {
    try {
        const res = await fetch('/api/fios');
        const data = await res.json();
        if (data.success) {
            allFios = data.fios;
        }
    } catch (e) {
        console.warn('Не удалось загрузить список ФИО:', e);
    }
});

const input = document.getElementById('fio-input');
const suggestions = document.getElementById('fio-suggestions');

input.addEventListener('input', () => {
    const val = input.value.trim().toLowerCase();
    fioIndex = -1;

    if (val.length < 2) {
        suggestions.classList.add('hidden');
        return;
    }

    const matches = allFios.filter(f => f.toLowerCase().includes(val)).slice(0, 15);
    if (matches.length === 0) {
        suggestions.classList.add('hidden');
        return;
    }

    suggestions.innerHTML = matches.map((f, i) =>
        `<div class="item" data-fio="${escHtml(f)}" onclick="selectFio('${escAttr(f)}')">${escHtml(f)}</div>`
    ).join('');
    suggestions.classList.remove('hidden');
});

input.addEventListener('keydown', (e) => {
    const items = suggestions.querySelectorAll('.item');
    if (!items.length) {
        if (e.key === 'Enter') loadErrors();
        return;
    }

    if (e.key === 'ArrowDown') {
        e.preventDefault();
        fioIndex = Math.min(fioIndex + 1, items.length - 1);
        updateMark(items);
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        fioIndex = Math.max(fioIndex - 1, 0);
        updateMark(items);
    } else if (e.key === 'Enter') {
        e.preventDefault();
        if (fioIndex >= 0 && fioIndex < items.length) {
            selectFio(items[fioIndex].dataset.fio);
        } else {
            loadErrors();
        }
    } else if (e.key === 'Escape') {
        suggestions.classList.add('hidden');
    }
});

document.addEventListener('click', (e) => {
    if (!suggestions.contains(e.target) && e.target !== input) {
        suggestions.classList.add('hidden');
    }
});

function updateMark(items) {
    items.forEach((el, i) => el.classList.toggle('marked', i === fioIndex));
}

function selectFio(fio) {
    input.value = fio;
    suggestions.classList.add('hidden');
    loadErrors();
}

async function loadErrors() {
    const fio = input.value.trim();
    if (!fio) {
        showError('Введите ФИО сотрудника');
        return;
    }

    hideError();
    document.getElementById('results').classList.add('hidden');
    document.getElementById('loading').classList.remove('hidden');

    try {
        const res = await fetch(`/api/errors/${encodeURIComponent(fio)}`);
        if (!res.ok) {
            const err = await res.json().catch(() => ({ detail: 'Ошибка сервера' }));
            throw new Error(err.detail || `HTTP ${res.status}`);
        }

        currentData = await res.json();

        if (!currentData.success) {
            throw new Error(currentData.message || 'Неизвестная ошибка');
        }

        renderResults(currentData);
        document.getElementById('results').classList.remove('hidden');
    } catch (e) {
        showError('Ошибка загрузки: ' + e.message);
    } finally {
        document.getElementById('loading').classList.add('hidden');
    }
}

function renderResults(data) {
    const summary = document.getElementById('summary');
    const totalPenalty = data.total_penalty > 0
        ? `<div class="card"><div class="value">${data.total_penalty}</div><div class="label">Штрафные баллы</div></div>`
        : '';

    summary.innerHTML = `
        <div class="card"><div class="value">${data.total_records}</div><div class="label">Всего записей</div></div>
        <div class="card"><div class="value">${escHtml(data.period)}</div><div class="label">Период</div></div>
        ${totalPenalty}
    `;

    renderPanel('panel-akty', data.akty, 'Акты', renderAktyCard);
    renderPanel('panel-internal', data.internal, 'Внутренние ошибки', renderInternalCard);
    renderPanel('panel-uz', data.uz, 'УЗ', renderUzCard);
    renderPanel('panel-other', data.other, 'Остальные ошибки', renderOtherCard);

    // activate first tab with data
    const tabs = ['akty', 'internal', 'uz', 'other'];
    const panels = ['panel-akty', 'panel-internal', 'panel-uz', 'panel-other'];
    const counts = [data.akty, data.internal, data.uz, data.other].map(d => d?.count || 0);

    let first = 0;
    for (let i = 0; i < counts.length; i++) {
        if (counts[i] > 0) { first = i; break; }
    }
    switchTab(tabs[first]);

    // update tab badges
    document.querySelectorAll('.tab').forEach(t => {
        const key = t.dataset.tab;
        const idx = tabs.indexOf(key);
        const count = counts[idx];
        t.textContent = `${['Акты', 'Внутренние', 'УЗ', 'Остальные'][idx]} (${count})`;
    });
}

function renderPanel(panelId, result, title, cardRenderer) {
    const el = document.getElementById(panelId);
    if (!result || !result.success || !result.data || result.data.length === 0) {
        el.innerHTML = '<div class="no-data">Нет данных</div>';
        return;
    }
    el.innerHTML = result.data.map((rec, i) => cardRenderer(rec, i + 1)).join('');
}

function renderAktyCard(rec, n) {
    return cardHtml(n, rec.penalty, [
        field('Дата', rec.date),
        field('Причина', rec.reason),
        field('Приложение', rec.application),
        field('Комментарий ОРО', rec.oro_comments, true),
        field('Детали', rec.details, true),
    ]);
}

function renderInternalCard(rec, n) {
    return cardHtml(n, rec.penalty, [
        field('Дата', rec.date),
        field('Причина', rec.reason),
        field('Отдел', rec.department),
        field('Товар', rec.product),
        field('Приложение', rec.application),
        field('Комментарий', rec.comment, true),
    ]);
}

function renderUzCard(rec, n) {
    return cardHtml(n, rec.penalty, [
        field('Дата', rec.date),
        field('Товар', rec.product),
        field('Приложение', rec.application),
        field('Детали ОРО', rec.oro_comments, true),
        field('Детали', rec.details, true),
    ]);
}

function renderOtherCard(rec, n) {
    return cardHtml(n, rec.penalty, [
        field('Дата', rec.date),
        field('Причина', rec.reason),
        field('Товар', rec.product),
        field('Приложение', rec.application),
        field('Детали', rec.details, true),
    ]);
}

function cardHtml(n, penalty, fields) {
    const pVal = parsePenalty(penalty);
    const pClass = pVal > 0 ? '' : ' zero';
    const pText = penalty ? penalty : '0';

    const fieldsHtml = fields
        .filter(f => f.value)
        .map(f => {
            const cls = f.full ? 'field full' : 'field';
            return `<div class="${cls}"><span class="field-label">${escHtml(f.label)}:</span><span class="field-value">${escHtml(f.value)}</span></div>`;
        })
        .join('');

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
    return { label, value: value || '', full };
}

function parsePenalty(val) {
    if (!val) return 0;
    return parseFloat(String(val).replace(',', '.')) || 0;
}

function switchTab(tab) {
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + tab));
}

function showError(msg) {
    const el = document.getElementById('error-message');
    el.textContent = msg;
    el.classList.remove('hidden');
}

function hideError() {
    document.getElementById('error-message').classList.add('hidden');
}

function escHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

function escAttr(s) {
    return s.replace(/'/g, "\\'").replace(/"/g, '&quot;');
}
