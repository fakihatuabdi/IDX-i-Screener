# Builds emitens.csv: for each ticker in the watchlist, real sector/industry from Yahoo
# Finance decides which XBRL taxonomy type (general/banking/insurance) its financial reports
# use - IDX's own taxonomy tags for revenue/income differ by industry (e.g. banks report
# "TotalInterestAndShariaIncome" instead of "SalesAndRevenue"), so parse_xbrl.py can't resolve
# the right tag without knowing this first. Also records each ticker's current shares
# outstanding, used as a fallback when a specific quarter's XBRL filing doesn't itself carry
# a shares-outstanding fact.
import argparse
import csv
import logging
import os
import time
from datetime import datetime
from pathlib import Path

import yfinance as yf

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s", datefmt="%Y-%m-%d %H:%M:%S")
logger = logging.getLogger(__name__)

DEFAULT_DATA_DIR = Path(__file__).resolve().parent / "data"
REQUEST_DELAY_SECONDS = 1.0  # be a polite, rate-limited caller of Yahoo Finance's free endpoint

EMITEN_FIELDS = ["ticker", "name", "sector", "industry", "taxonomy_type", "shares_outstanding", "updated_at"]


def classify_taxonomy(sector: str, industry: str) -> str:
    if "insurance" in industry.lower():
        return "insurance"
    if "Financial" in sector:
        return "banking"
    return "general"


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


def save_emitens(path: Path, emitens: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(".csv.tmp")
    with open(tmp_path, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=EMITEN_FIELDS)
        writer.writeheader()
        for ticker in sorted(emitens):
            writer.writerow(emitens[ticker])
    os.replace(tmp_path, path)


def sync(tickers: list) -> dict:
    emitens = {}
    ok, failed = 0, 0
    for ticker in tickers:
        try:
            info = yf.Ticker(f"{ticker}.JK").info
            sector = info.get("sector") or "Unknown"
            industry = info.get("industry") or "Unknown"
            emitens[ticker] = {
                "ticker": ticker,
                "name": info.get("longName") or ticker,
                "sector": sector,
                "industry": industry,
                "taxonomy_type": classify_taxonomy(sector, industry),
                "shares_outstanding": info.get("sharesOutstanding") or 0,
                "updated_at": datetime.now().isoformat(timespec="seconds"),
            }
            ok += 1
        except Exception:
            logger.exception("Failed to fetch master data for %s", ticker)
            failed += 1
        time.sleep(REQUEST_DELAY_SECONDS)
    logger.info("Master data sync done: %d ok, %d failed", ok, failed)
    return emitens


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Sync sector/industry/shares for the watchlist via yfinance.")
    parser.add_argument("--data-dir", type=Path, default=DEFAULT_DATA_DIR)
    parser.add_argument("--watchlist", type=Path, default=None)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    watchlist_path = args.watchlist or (args.data_dir / "watchlist.csv")
    tickers = load_watchlist(watchlist_path)
    logger.info("Loaded %d tickers from %s", len(tickers), watchlist_path)
    emitens = sync(tickers)
    save_emitens(args.data_dir / "emitens.csv", emitens)


if __name__ == "__main__":
    main()
