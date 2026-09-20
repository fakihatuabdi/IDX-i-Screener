# Downloads each ticker's quarterly XBRL financial-report archive straight from IDX's own
# static file server (idx.co.id) - the same official filings every listed company is required
# to submit, not a third-party mirror. IDX's own server sits behind Cloudflare and returns a
# JS challenge to plain requests, hence cloudscraper instead of plain `requests`. Deliberately
# throttled (REQUEST_DELAY_SECONDS between tickers) since this hits IDX's real infrastructure -
# this is a slow, occasional bulk job, never part of the fast daily update.
import argparse
import csv
import io
import logging
import time
import zipfile
from datetime import datetime
from pathlib import Path

import cloudscraper
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s", datefmt="%Y-%m-%d %H:%M:%S")
logger = logging.getLogger(__name__)

DEFAULT_DATA_DIR = Path(__file__).resolve().parent / "data"

# IDX only publishes interim reports for Q1-Q3 under this path (the "TW" - Triwulan/quarter -
# folders); Q4 numbers come from the annual report instead, which uses a different, unrelated
# URL structure and isn't covered here.
PERIODS = [("TW1", "Q1"), ("TW2", "Q2"), ("TW3", "Q3")]

IDX_URL_TEMPLATE = (
    "https://www.idx.co.id/Portals/0/StaticData/ListedCompanies/Corporate_Actions/"
    "New_Info_JSX/Jenis_Informasi/01_Laporan_Keuangan/02_Soft_Copy_Laporan_Keuangan/"
    "/Laporan%20Keuangan%20Tahun%20{year}/{period_folder}/{ticker}/instance.zip"
)

MAX_RETRIES = 3
RETRY_BACKOFF_SECONDS = [5, 15, 45]
REQUEST_TIMEOUT_SECONDS = 30
REQUEST_DELAY_SECONDS = 1.5


def load_watchlist(path: Path) -> list:
    if not path.exists():
        raise FileNotFoundError(f"Watchlist not found: {path}")
    tickers, seen = [], set()
    with open(path, "r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            ticker = (row["ticker"] or "").strip().upper()
            if ticker and ticker not in seen:
                seen.add(ticker)
                tickers.append(ticker)
    return tickers


def log_failure(path: Path, ticker: str, year: int, period: str, reason: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    is_new = not path.exists()
    with open(path, "a", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        if is_new:
            writer.writerow(["ticker", "year", "period", "reason", "logged_at"])
        writer.writerow([ticker, year, period, reason, datetime.now().isoformat()])


def download_with_retry(scraper, url: str):
    last_error = None
    for attempt in range(MAX_RETRIES):
        try:
            return scraper.get(url, timeout=REQUEST_TIMEOUT_SECONDS)
        except (requests.exceptions.Timeout, requests.exceptions.ConnectionError) as e:
            last_error = e
            if attempt < MAX_RETRIES - 1:
                time.sleep(RETRY_BACKOFF_SECONDS[attempt])
    raise last_error


def fetch_all(tickers: list, xbrl_dir: Path, failed_log: Path, start_year: int, end_year: int) -> None:
    scraper = cloudscraper.create_scraper(browser={"browser": "chrome", "platform": "windows", "mobile": False})
    saved = missing = errors = 0

    for year in range(start_year, end_year + 1):
        for period_folder, period_tag in PERIODS:
            for ticker in tickers:
                target_dir = xbrl_dir / str(year) / period_tag
                target_file = target_dir / f"{ticker}_{year}_{period_tag}.xbrl"
                if target_file.exists():
                    continue  # already have this filing from a previous run - don't re-download it

                url = IDX_URL_TEMPLATE.format(year=year, period_folder=period_folder, ticker=ticker)
                try:
                    response = download_with_retry(scraper, url)
                    if response.status_code != 200:
                        missing += 1  # not filed yet, or ticker didn't exist that quarter - not an error
                    else:
                        with zipfile.ZipFile(io.BytesIO(response.content)) as z:
                            xbrl_name = next((n for n in z.namelist() if n.endswith((".xbrl", ".xml"))), None)
                            if xbrl_name is None:
                                missing += 1
                            else:
                                target_dir.mkdir(parents=True, exist_ok=True)
                                target_file.write_bytes(z.read(xbrl_name))
                                saved += 1
                except Exception as e:
                    logger.error("Failed %s %s %s: %s", ticker, year, period_tag, e)
                    log_failure(failed_log, ticker, year, period_tag, str(e))
                    errors += 1
                time.sleep(REQUEST_DELAY_SECONDS)
            logger.info("year=%s period=%s so far: %d saved, %d missing, %d errors", year, period_tag, saved, missing, errors)


def parse_args() -> argparse.Namespace:
    current_year = datetime.now().year
    parser = argparse.ArgumentParser(description="Download IDX quarterly XBRL filings for a watchlist.")
    parser.add_argument("--data-dir", type=Path, default=DEFAULT_DATA_DIR)
    parser.add_argument("--watchlist", type=Path, default=None)
    parser.add_argument("--start-year", type=int, default=2023)
    parser.add_argument("--end-year", type=int, default=current_year)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    watchlist_path = args.watchlist or (args.data_dir / "watchlist.csv")
    tickers = load_watchlist(watchlist_path)
    if not tickers:
        logger.warning("Watchlist is empty, nothing to download")
        return
    logger.info("Loaded %d tickers from %s", len(tickers), watchlist_path)
    fetch_all(tickers, args.data_dir / "XBRL", args.data_dir / "failed_downloads.csv", args.start_year, args.end_year)


if __name__ == "__main__":
    main()
