# Pulls real quarterly financial statements for each watchlist ticker straight from Yahoo
# Finance via yfinance - NOT from idx.co.id's own XBRL filings. That was the original plan
# (see git history for fetch_idx.py/parse_xbrl.py), but idx.co.id sits behind a Cloudflare
# challenge that blocked every request in testing - even cloudscraper solving the JS challenge
# from a real home network still got the "Just a moment..." page, not the actual file. Yahoo
# already aggregates the same real IDX-reported figures for .JK tickers and its data endpoints
# are what yfinance is built to call, so this sidesteps the block entirely with a much simpler
# pipeline (one script instead of three, no XBRL tag taxonomy to maintain).
#
# Trade-off worth knowing: Yahoo's quarterly statements only go back ~5-6 quarters (its own
# free-tier limit, not something a wider --start-year/--end-year range can fix) - real, working
# data for roughly the last year and a half, rather than the deeper 2023+ history XBRL might
# have given if it had been reachable at all.
import argparse
import csv
import logging
import math
import os
import time
from pathlib import Path

import yfinance as yf

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s", datefmt="%Y-%m-%d %H:%M:%S")
logger = logging.getLogger(__name__)

DEFAULT_DATA_DIR = Path(__file__).resolve().parent / "data"
REQUEST_DELAY_SECONDS = 1.0

REPORT_FIELDS = [
    "ticker", "year", "period",
    "total_assets", "current_assets", "total_liabilities", "current_liabilities",
    "total_equity", "revenue", "net_income", "operating_cash_flow", "capital_expenditure",
    "free_cash_flow", "outstanding_shares",
]

# yfinance's line-item names vary by company/sector (a bank's balance sheet has no "Current
# Assets" line at all, and some companies report cash flow with a "direct method" line instead
# of the usual "Operating Cash Flow") - each concept tries its real candidates in order and
# just returns null if none are present, rather than guessing or fabricating a number.
FIELD_CANDIDATES = {
    "revenue": ["Total Revenue", "Operating Revenue"],
    "net_income": ["Net Income", "Net Income Common Stockholders"],
    "total_assets": ["Total Assets"],
    "current_assets": ["Current Assets"],
    "total_liabilities": ["Total Liabilities Net Minority Interest"],
    "current_liabilities": ["Current Liabilities"],
    "total_equity": ["Stockholders Equity", "Common Stock Equity"],
    "outstanding_shares": ["Ordinary Shares Number", "Share Issued"],
    "operating_cash_flow": ["Operating Cash Flow", "Cash Flow From Continuing Operating Activities", "Cash Flowsfromusedin Operating Activities Direct"],
    "capital_expenditure": ["Capital Expenditure", "Purchase Of PPE"],
    "free_cash_flow": ["Free Cash Flow"],
}

PERIOD_BY_MONTH = {3: "Q1", 6: "Q2", 9: "Q3", 12: "Q4"}


def load_watchlist(path: Path) -> list:
    if not path.exists():
        raise FileNotFoundError(f"Watchlist not found: {path}")
    tickers, seen = [], set()
    with open(path, "r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        if not reader.fieldnames or "ticker" not in reader.fieldnames:
            raise ValueError(f"{path} must contain a 'ticker' column")
        for row in reader:
            ticker = (row["ticker"] or "").strip().upper()
            if ticker and ticker not in seen:
                seen.add(ticker)
                tickers.append(ticker)
    return tickers


def load_reports(path: Path) -> dict:
    reports = {}
    if not path.exists():
        return reports
    with open(path, "r", encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            reports[(row["ticker"], int(row["year"]), row["period"])] = row
    return reports


def save_reports(path: Path, reports: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(".csv.tmp")
    with open(tmp_path, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=REPORT_FIELDS)
        writer.writeheader()
        for key in sorted(reports):
            writer.writerow({field: reports[key].get(field, "") for field in REPORT_FIELDS})
    os.replace(tmp_path, path)


def resolve(df, column, concept: str):
    if df is None or column not in df.columns:
        return None
    for candidate in FIELD_CANDIDATES[concept]:
        if candidate not in df.index:
            continue
        value = df.loc[candidate, column]
        try:
            value = float(value)
        except (TypeError, ValueError):
            continue
        if math.isnan(value):
            continue
        return value
    return None


def fetch_ticker(ticker: str) -> list:
    info = yf.Ticker(f"{ticker}.JK")
    fin, bs, cf = info.quarterly_financials, info.quarterly_balance_sheet, info.quarterly_cashflow
    if fin is None or fin.empty:
        return []

    rows = []
    for column in fin.columns:
        period = PERIOD_BY_MONTH.get(column.month)
        if period is None:
            continue
        row = {"ticker": ticker, "year": column.year, "period": period}
        for concept in ("revenue", "net_income"):
            row[concept] = resolve(fin, column, concept)
        for concept in ("total_assets", "current_assets", "total_liabilities", "current_liabilities", "total_equity", "outstanding_shares"):
            row[concept] = resolve(bs, column, concept)
        for concept in ("operating_cash_flow", "capital_expenditure", "free_cash_flow"):
            row[concept] = resolve(cf, column, concept)
        rows.append(row)
    return rows


def fetch_all(tickers: list) -> dict:
    reports = {}
    ok, empty, errors = 0, 0, 0
    for ticker in tickers:
        try:
            rows = fetch_ticker(ticker)
            if not rows:
                empty += 1
            for row in rows:
                reports[(row["ticker"], row["year"], row["period"])] = row
            ok += 1
        except Exception:
            logger.exception("Failed to fetch %s", ticker)
            errors += 1
        time.sleep(REQUEST_DELAY_SECONDS)
    logger.info("Fetched %d tickers (%d had no quarterly data, %d errors), %d quarter-rows total", ok, empty, errors, len(reports))
    return reports


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Fetch real quarterly financials for a watchlist via Yahoo Finance.")
    parser.add_argument("--data-dir", type=Path, default=DEFAULT_DATA_DIR)
    parser.add_argument("--watchlist", type=Path, default=None)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    watchlist_path = args.watchlist or (args.data_dir / "watchlist.csv")
    tickers = load_watchlist(watchlist_path)
    logger.info("Loaded %d tickers from %s", len(tickers), watchlist_path)

    reports_path = args.data_dir / "financial_reports.csv"
    reports = load_reports(reports_path)
    reports.update(fetch_all(tickers))
    save_reports(reports_path, reports)
    logger.info("Wrote %d rows to %s", len(reports), reports_path)


if __name__ == "__main__":
    main()
