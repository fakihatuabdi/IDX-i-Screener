# Orchestrates the three stages: sync sector/taxonomy classification and share counts, then
# download, then parse. Runs as its own occasional GitHub Actions job (fundamental-scraper.yml)
# - deliberately NOT part of the fast daily update, since a full multi-year pull is slow and
# hits IDX's own real infrastructure with a deliberate delay between requests.
import argparse
import logging
import subprocess
import sys
import time
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s", datefmt="%Y-%m-%d %H:%M:%S")
logger = logging.getLogger(__name__)

SCRIPT_DIR = Path(__file__).resolve().parent


def run_step(name: str, script: str, args: list) -> None:
    command = [sys.executable, str(SCRIPT_DIR / script), *args]
    logger.info("Step started: %s", name)
    started = time.time()
    result = subprocess.run(command)
    if result.returncode != 0:
        raise RuntimeError(f"Step '{name}' failed with exit code {result.returncode}")
    logger.info("Step finished: %s (%.1fs)", name, time.time() - started)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the IDX fundamentals pipeline: master data, download, parse.")
    parser.add_argument("--data-dir", type=Path, default=SCRIPT_DIR / "data")
    parser.add_argument("--watchlist", type=Path, default=None)
    parser.add_argument("--start-year", type=int, default=None)
    parser.add_argument("--end-year", type=int, default=None)
    parser.add_argument("--skip-master", action="store_true")
    parser.add_argument("--skip-fetch", action="store_true")
    parser.add_argument("--skip-parse", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    base_args = ["--data-dir", str(args.data_dir)]
    watchlist_args = ["--watchlist", str(args.watchlist)] if args.watchlist else []
    year_args = []
    if args.start_year is not None:
        year_args += ["--start-year", str(args.start_year)]
    if args.end_year is not None:
        year_args += ["--end-year", str(args.end_year)]

    steps = []
    if not args.skip_master:
        steps.append(("Master data sync", "master_data.py", base_args + watchlist_args))
    if not args.skip_fetch:
        steps.append(("IDX XBRL download", "fetch_idx.py", base_args + watchlist_args + year_args))
    if not args.skip_parse:
        steps.append(("XBRL parsing", "parse_xbrl.py", base_args + year_args))

    started = time.time()
    try:
        for name, script, step_args in steps:
            run_step(name, script, step_args)
    except RuntimeError as e:
        logger.error("%s", e)
        return 1

    logger.info("Pipeline finished in %.1fs. Output: %s", time.time() - started, args.data_dir / "financial_reports.csv")
    return 0


if __name__ == "__main__":
    sys.exit(main())
