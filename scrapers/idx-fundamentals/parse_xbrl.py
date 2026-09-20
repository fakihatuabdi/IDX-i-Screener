# Parses downloaded XBRL filings into financial_reports.csv - one row per ticker/year/quarter
# with the core balance-sheet, income-statement and cash-flow figures the dashboard's
# fundamental scoring needs (real EPS/BVPS for the Graham Number in lib/pipeline.mjs, revenue
# and net income for growth trends). XBRL tags are looked up per taxonomy_type (general/
# banking/insurance) because IDX's own taxonomy uses different tag names by industry - see
# taxonomy.csv. Every numeric fact in a filing has a `contextRef` pointing at a reporting
# period; only the "current period" context is kept, since prior-period comparatives are also
# embedded in the same file and would otherwise silently overwrite the real current figure.
import argparse
import csv
import logging
import os
from datetime import datetime
from pathlib import Path

from bs4 import BeautifulSoup

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s", datefmt="%Y-%m-%d %H:%M:%S")
logger = logging.getLogger(__name__)

DEFAULT_DATA_DIR = Path(__file__).resolve().parent / "data"
PERIODS = ["Q1", "Q2", "Q3"]

METRIC_FIELDS = [
    "total_assets", "current_assets", "total_liabilities", "current_liabilities",
    "total_equity", "revenue", "net_income", "operating_cash_flow",
    "capital_expenditure", "outstanding_shares",
]
OUTPUT_FIELDS = ["ticker", "year", "period", "currency"] + METRIC_FIELDS + ["revenue_tag_source"]

TRUE_VALUES = {"1", "true", "t", "yes", "y"}


def load_taxonomy(path: Path) -> dict:
    maps = {}
    with open(path, "r", encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            term_map = maps.setdefault(row["taxonomy_type"].strip(), {})
            term_map.setdefault(row["common_term"].strip(), []).append(row["xbrl_tag"].strip())
    return maps


def load_emitens(path: Path) -> list:
    emitens = []
    with open(path, "r", encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            ticker = (row.get("ticker") or "").strip().upper()
            taxonomy_type = (row.get("taxonomy_type") or "general").strip() or "general"
            if ticker:
                emitens.append((ticker, taxonomy_type, row.get("shares_outstanding") or 0))
    return emitens


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
        writer = csv.DictWriter(f, fieldnames=OUTPUT_FIELDS)
        writer.writeheader()
        for key in sorted(reports):
            writer.writerow({field: reports[key].get(field, "") for field in OUTPUT_FIELDS})
    os.replace(tmp_path, path)


def build_context_labels(soup: BeautifulSoup, year: int) -> dict:
    # XBRL attribute/element names (contextRef, endDate) are camelCase and XML is
    # case-sensitive - BeautifulSoup's lxml-xml parser preserves that case as-is (unlike its
    # HTML parser, which lowercases everything), so these lookups must match exactly.
    labels = {}
    for ctx in soup.find_all("context"):
        ctx_id = ctx.get("id")
        instant, end_date = ctx.find("instant"), ctx.find("endDate")
        date_text = (instant or end_date).text if (instant or end_date) else None
        if date_text is None:
            continue
        labels[ctx_id] = "current" if date_text.startswith(str(year)) else "prior"
    return labels


def extract_facts(soup: BeautifulSoup, context_labels: dict) -> dict:
    facts = {}
    for el in soup.find_all(True):
        if not el.has_attr("contextRef"):
            continue
        try:
            value = float(el.text.strip())
        except ValueError:
            continue
        tag = el.name.split(":")[-1]
        label = context_labels.get(el.get("contextRef"), "unknown")
        facts.setdefault(tag.lower(), []).append((value, label))
    return facts


def resolve(candidate_tags: list, facts: dict):
    for tag in candidate_tags:
        entries = facts.get(tag.split(":")[-1].lower())
        if entries:
            current = [v for v, label in entries if label == "current"]
            return (current[0] if current else entries[0][0]), tag
    return None, None


def parse_filing(ticker: str, year: int, period: str, taxonomy_type: str, taxonomy: dict, xbrl_path: Path) -> dict:
    with open(xbrl_path, "r", encoding="utf-8") as f:
        soup = BeautifulSoup(f.read(), "lxml-xml")

    context_labels = build_context_labels(soup, year)
    facts = extract_facts(soup, context_labels)
    currency = "USD" if soup.find(string=lambda t: t and "usd" in t.lower() and "iso4217" in t.lower()) else "IDR"

    row = {"ticker": ticker, "year": year, "period": period, "currency": currency}
    revenue_tag_source = ""
    for term, candidate_tags in taxonomy.get(taxonomy_type, {}).items():
        value, tag_source = resolve(candidate_tags, facts)
        row[term] = value if value is not None else ""
        if term == "revenue":
            revenue_tag_source = tag_source or "not_found"
    row["revenue_tag_source"] = revenue_tag_source
    return row


def parse_all(emitens: list, taxonomy: dict, xbrl_dir: Path, reports: dict, start_year: int, end_year: int) -> None:
    for year in range(start_year, end_year + 1):
        for period in PERIODS:
            processed = skipped = errors = 0
            for ticker, taxonomy_type, shares_fallback in emitens:
                xbrl_path = xbrl_dir / str(year) / period / f"{ticker}_{year}_{period}.xbrl"
                if not xbrl_path.exists():
                    skipped += 1
                    continue
                try:
                    row = parse_filing(ticker, year, period, taxonomy_type, taxonomy, xbrl_path)
                    if not row.get("outstanding_shares") and shares_fallback:
                        # This specific filing didn't itself carry a shares-outstanding fact -
                        # fall back to the latest known share count from master_data.py rather
                        # than leaving EPS/BVPS impossible to compute for this quarter.
                        row["outstanding_shares"] = shares_fallback
                    reports[(ticker, year, period)] = row
                    processed += 1
                except Exception:
                    logger.exception("Failed to parse %s %s %s", ticker, year, period)
                    errors += 1
            logger.info("year=%s period=%s: %d parsed, %d no filing, %d errors", year, period, processed, skipped, errors)


def parse_args() -> argparse.Namespace:
    current_year = datetime.now().year
    parser = argparse.ArgumentParser(description="Parse downloaded IDX XBRL filings into financial_reports.csv.")
    parser.add_argument("--data-dir", type=Path, default=DEFAULT_DATA_DIR)
    parser.add_argument("--start-year", type=int, default=2023)
    parser.add_argument("--end-year", type=int, default=current_year)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    taxonomy = load_taxonomy(args.data_dir / "taxonomy.csv")
    emitens = load_emitens(args.data_dir / "emitens.csv")
    reports = load_reports(args.data_dir / "financial_reports.csv")
    logger.info("Parsing XBRL for %d issuers (%s-%s)", len(emitens), args.start_year, args.end_year)
    parse_all(emitens, taxonomy, args.data_dir / "XBRL", reports, args.start_year, args.end_year)
    save_reports(args.data_dir / "financial_reports.csv", reports)
    logger.info("Wrote %d rows to %s", len(reports), args.data_dir / "financial_reports.csv")


if __name__ == "__main__":
    main()
