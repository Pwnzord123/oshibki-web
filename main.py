"""Веб-приложение для работы с Google Таблицей ошибок (FastAPI)"""

import os
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Optional, List, Dict

import gspread
from google.oauth2.service_account import Credentials
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

# ============================================================================
# НАСТРОЙКИ
# ============================================================================

SERVICE_ACCOUNT_FILE = "oshibki_service_account.json"
SPREADSHEET_ID = "1E883zDPF-9lPF5u3VoxmwrSN0tipoEFS9rDNDQR-5kg"

GOOGLE_SCOPES = [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive',
]

SHEET_NAMES = {
    'akty': 'Акты',
    'uz': 'УЗ',
    'other_errors': 'Остальные ошибки',
    'internal_errors': 'Внутренние ошибки',
}

# ============================================================================
# GOOGLE SHEETS CLIENT
# ============================================================================

class GoogleSheetsClient:
    def __init__(self):
        self.client = None
        self.spreadsheet = None

    def connect(self) -> bool:
        if not os.path.exists(SERVICE_ACCOUNT_FILE):
            raise FileNotFoundError(f"Файл {SERVICE_ACCOUNT_FILE} не найден!")
        creds = Credentials.from_service_account_file(SERVICE_ACCOUNT_FILE, scopes=GOOGLE_SCOPES)
        self.client = gspread.authorize(creds)
        self.spreadsheet = self.client.open_by_key(SPREADSHEET_ID)
        return True

    def get_worksheet(self, sheet_name: str):
        return self.spreadsheet.worksheet(sheet_name)

    def get_all_data(self, sheet_name: str) -> Optional[List[List]]:
        worksheet = self.get_worksheet(sheet_name)
        return worksheet.get_all_values()

    def get_sheet_names(self) -> List[str]:
        return [ws.title for ws in self.spreadsheet.worksheets()]

    def get_unique_fios(self) -> List[str]:
        all_fios = set()
        for sheet_key in SHEET_NAMES.values():
            try:
                data = self.get_all_data(sheet_key)
                if not data or len(data) < 2:
                    continue
                headers = data[0]
                fio_col = -1
                for i, h in enumerate(headers):
                    hl = str(h).lower().strip()
                    if 'фио' in hl:
                        fio_col = i
                        break
                if fio_col == -1:
                    continue
                for row in data[1:]:
                    if fio_col < len(row):
                        val = str(row[fio_col]).strip()
                        if val:
                            all_fios.add(val)
            except Exception:
                continue
        return sorted(all_fios)


sheets_client = GoogleSheetsClient()


# ============================================================================
# DATA PROCESSORS
# ============================================================================

def _safe_get(row, index):
    if index == -1 or index >= len(row):
        return ''
    return str(row[index]).strip()


def _find_col(headers, *keywords):
    for i, h in enumerate(headers):
        hl = str(h).lower().strip()
        if all(k in hl for k in keywords):
            return i
    return -1


def _calc_period(records):
    dates = []
    for rec in records:
        try:
            dates.append(datetime.strptime(rec.get('date', ''), '%d.%m.%Y'))
        except Exception:
            pass
    if not dates:
        return 'Нет данных'
    mn, mx = min(dates), max(dates)
    return mn.strftime('%d.%m.%Y') if mn == mx else f"{mn.strftime('%d.%m.%Y')} — {mx.strftime('%d.%m.%Y')}"


def _parse_float(val):
    try:
        return float(str(val).replace(',', '.'))
    except Exception:
        return 0.0


def process_akty(fio: str = None) -> dict:
    data = sheets_client.get_all_data(SHEET_NAMES['akty'])
    if not data or len(data) < 2:
        return {'success': False, 'message': 'Лист пуст'}
    headers = data[0]
    cols = {
        'date': _find_col(headers, 'дата', 'ошибк'),
        'fio': _find_col(headers, 'фио', 'виновн'),
        'reason': _find_col(headers, 'причин', 'ошибк'),
        'application': _find_col(headers, 'приложение'),
        'penalty': _find_col(headers, 'штрафн', 'балл'),
        'oro_comments': _find_col(headers, 'комментар', 'оро'),
        'details': _find_col(headers, 'детально'),
    }
    fio_norm = fio.lower().replace('  ', ' ').strip() if fio else None
    records = []
    for row in data[1:]:
        if fio_norm and cols['fio'] != -1:
            row_fio = _safe_get(row, cols['fio']).lower().replace('  ', ' ')
            if row_fio != fio_norm:
                continue
        records.append({k: _safe_get(row, v) for k, v in cols.items()})
    return {
        'success': True,
        'sheet': SHEET_NAMES['akty'],
        'count': len(records),
        'period': _calc_period(records),
        'data': records,
    }


def process_internal(fio: str = None) -> dict:
    data = sheets_client.get_all_data(SHEET_NAMES['internal_errors'])
    if not data or len(data) < 2:
        return {'success': False, 'message': 'Лист пуст'}
    headers = data[0]
    cols = {
        'date': _find_col(headers, 'дата', 'ошибк'),
        'fio': _find_col(headers, 'фио', 'сотрудн'),
        'reason': _find_col(headers, 'причина'),
        'department': _find_col(headers, 'отдел'),
        'product': _find_col(headers, 'товар'),
        'comment': _find_col(headers, 'комментар'),
        'application': _find_col(headers, 'приложение'),
        'penalty': _find_col(headers, 'сумма', 'штраф'),
    }
    fio_norm = fio.lower().replace('  ', ' ').strip() if fio else None
    records = []
    for row in data[1:]:
        if fio_norm and cols['fio'] != -1:
            row_fio = _safe_get(row, cols['fio']).lower().replace('  ', ' ')
            if row_fio != fio_norm:
                continue
        records.append({k: _safe_get(row, v) for k, v in cols.items()})
    return {
        'success': True,
        'sheet': SHEET_NAMES['internal_errors'],
        'count': len(records),
        'period': _calc_period(records),
        'data': records,
    }


def process_uz(fio: str = None) -> dict:
    data = sheets_client.get_all_data(SHEET_NAMES['uz'])
    if not data or len(data) < 2:
        return {'success': False, 'message': 'Лист пуст'}
    headers = data[0]
    cols = {
        'fio': _find_col(headers, 'фио', 'виновн'),
        'oro_comments': _find_col(headers, 'комментар', 'оро'),
        'details': _find_col(headers, 'детально'),
        'penalty': _find_col(headers, 'штрафн', 'балл'),
        'application': _find_col(headers, 'приложение'),
        'product': _find_col(headers, 'товар'),
        'date': _find_col(headers, 'дата', 'факт'),
    }
    fio_norm = fio.lower().replace('  ', ' ').strip() if fio else None
    records = []
    for row in data[1:]:
        if fio_norm and cols['fio'] != -1:
            row_fio = _safe_get(row, cols['fio']).lower().replace('  ', ' ')
            if row_fio != fio_norm:
                continue
        records.append({k: _safe_get(row, v) for k, v in cols.items()})
    return {
        'success': True,
        'sheet': SHEET_NAMES['uz'],
        'count': len(records),
        'period': _calc_period(records),
        'data': records,
    }


def process_other(fio: str = None) -> dict:
    data = sheets_client.get_all_data(SHEET_NAMES['other_errors'])
    if not data or len(data) < 2:
        return {'success': False, 'message': 'Лист пуст'}
    headers = data[0]
    cols = {
        'date': _find_col(headers, 'дата', 'ошибк'),
        'reason': _find_col(headers, 'причин', 'ошибк'),
        'product': _find_col(headers, 'товар', 'наименован'),
        'details': _find_col(headers, 'детально'),
        'fio': _find_col(headers, 'фио', 'виновн'),
        'penalty': _find_col(headers, 'штрафн', 'балл'),
        'application': _find_col(headers, 'приложение'),
    }
    fio_norm = fio.lower().replace('  ', ' ').strip() if fio else None
    records = []
    for row in data[1:]:
        if fio_norm and cols['fio'] != -1:
            row_fio = _safe_get(row, cols['fio']).lower().replace('  ', ' ')
            if row_fio != fio_norm:
                continue
        records.append({k: _safe_get(row, v) for k, v in cols.items()})
    return {
        'success': True,
        'sheet': SHEET_NAMES['other_errors'],
        'count': len(records),
        'period': _calc_period(records),
        'data': records,
    }


# ============================================================================
# FASTAPI
# ============================================================================

@asynccontextmanager
async def lifespan(application):
    sheets_client.connect()
    yield

app = FastAPI(title="Ошибка — Таблица ошибок", lifespan=lifespan)

app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
def index():
    return FileResponse("static/index.html")


@app.get("/api/fios")
def api_fios():
    try:
        fios = sheets_client.get_unique_fios()
        return {"success": True, "fios": fios}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/test")
def api_test():
    try:
        names = sheets_client.get_sheet_names()
        return {"success": True, "title": sheets_client.spreadsheet.title, "sheets": names}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/errors/{fio:path}")
def api_errors(fio: str):
    try:
        akty = process_akty(fio)
        internal = process_internal(fio)
        uz = process_uz(fio)
        other = process_other(fio)

        total_records = 0
        total_penalty = 0.0
        all_dates = []
        categories = {}

        for name, result in [('Акты', akty), ('Внутренние ошибки', internal), ('УЗ', uz), ('Остальные ошибки', other)]:
            if result.get('success') and result.get('data'):
                count = len(result['data'])
                total_records += count
                categories[name] = count
                for rec in result['data']:
                    total_penalty += _parse_float(rec.get('penalty', '0'))
                    try:
                        all_dates.append(datetime.strptime(rec.get('date', ''), '%d.%m.%Y'))
                    except Exception:
                        pass

        period = 'Нет данных'
        if all_dates:
            mn, mx = min(all_dates), max(all_dates)
            period = mn.strftime('%d.%m.%Y') if mn == mx else f"{mn.strftime('%d.%m.%Y')} — {mx.strftime('%d.%m.%Y')}"

        return {
            "success": True,
            "fio": fio,
            "period": period,
            "total_records": total_records,
            "total_penalty": round(total_penalty, 1),
            "categories": categories,
            "akty": akty,
            "internal": internal,
            "uz": uz,
            "other": other,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
