"""Date helpers — year-only and BC/AC-aware, never crash on missing dates."""

from __future__ import annotations

from typing import Optional


def compose_date(
    year: Optional[int | str],
    month: Optional[int | str] = None,
    day: Optional[int | str] = None,
    era: str = "ac",
) -> Optional[str]:
    """
    Build a Historia date string from form parts.

    era: "bc" | "ac" (After Century / Before Christ).
    Year alone → "1815" or "-0044".
    With month → "1815-06" / "-0044-03".
    With day → "1815-06-18" / "-0044-03-15".
    Returns None if year is missing/blank.
    """
    if year is None or str(year).strip() == "":
        return None
    try:
        y = int(str(year).strip())
    except ValueError:
        return None
    if y < 0:
        y = abs(y)

    m: Optional[int] = None
    d: Optional[int] = None
    if month is not None and str(month).strip() != "":
        try:
            m = min(max(int(str(month).strip()), 1), 12)
        except ValueError:
            m = None
    if m is not None and day is not None and str(day).strip() != "":
        try:
            d = min(max(int(str(day).strip()), 1), 31)
        except ValueError:
            d = None

    era_l = (era or "ac").strip().lower()
    is_bc = era_l in ("bc", "bce", "before")

    if is_bc:
        year_part = f"-{y:04d}" if y < 10000 else f"-{y}"
    else:
        year_part = str(y)

    if m is None:
        return year_part
    if d is None:
        return f"{year_part}-{m:02d}"
    return f"{year_part}-{m:02d}-{d:02d}"


def parse_historia_date(value: Optional[str]) -> Optional[tuple[int, int, int]]:
    """
    Parse a Historia date string into (year, month, day).

    Accepts:
      - full ISO: "1815-06-18", "-0044-03-15"
      - year-month: "1815-06", "-0044-03"
      - year-only: "1815", "-0044", "44 BCE" / "44BC" / "44 BC"

    Returns None if missing or unparseable (caller sorts those to the end).
    Year may be negative for BC.
    """
    if value is None:
        return None
    raw = value.strip()
    if not raw:
        return None

    upper = raw.upper().replace(" ", "")
    if upper.endswith("BCE") or upper.endswith("BC") or upper.endswith("AC") or upper.endswith("CE") or upper.endswith("AD"):
        digits = "".join(c for c in upper if c.isdigit())
        if not digits:
            return None
        try:
            y = int(digits)
            if upper.endswith("BCE") or upper.endswith("BC"):
                return (-y, 1, 1)
            return (y, 1, 1)
        except ValueError:
            return None

    negative = raw.startswith("-")
    body = raw[1:] if negative else raw
    parts = body.split("-")
    try:
        year = int(parts[0])
        if negative:
            year = -year
        month = int(parts[1]) if len(parts) > 1 and parts[1] else 1
        day = int(parts[2]) if len(parts) > 2 and parts[2] else 1
        month = min(max(month, 1), 12)
        day = min(max(day, 1), 31)
        return (year, month, day)
    except (ValueError, IndexError):
        return None


def date_sort_key(value: Optional[str]) -> tuple:
    """Dated items first (chronological); missing/unparseable dates sort to the end."""
    parsed = parse_historia_date(value)
    if parsed is None:
        return (1, 0, 0, 0)
    year, month, day = parsed
    return (0, year, month, day)


def format_year_number(year: int) -> str:
    """Absolute year with thousands separators (e.g. 3300 → '3,300')."""
    return f"{abs(int(year)):,}"


def format_display_date(value: Optional[str]) -> str:
    """Human-readable date for UI badges — uses BC / AC labels."""
    if not value or not str(value).strip():
        return ""
    parsed = parse_historia_date(value)
    if parsed is None:
        return ""
    year, _month, _day = parsed
    year_label = format_year_number(year)
    era = "BC" if year < 0 else "AC"

    body = value.lstrip("-")
    parts = body.split("-")
    has_month = len(parts) >= 2 and parts[1].isdigit()
    has_day = len(parts) >= 3 and parts[2].isdigit()

    if has_day and has_month:
        return f"{int(parts[2])}/{int(parts[1])}/{year_label} {era}"
    if has_month:
        return f"{int(parts[1])}/{year_label} {era}"
    return f"{year_label} {era}"


def format_date_range(start: Optional[str], end: Optional[str]) -> str:
    a = format_display_date(start)
    b = format_display_date(end)
    if a and b:
        return f"{a} – {b}"
    return a or b or ""


def split_date_parts(value: Optional[str]) -> dict:
    """Split stored date into form parts: year, month, day, era."""
    parsed = parse_historia_date(value)
    if parsed is None:
        return {"year": "", "month": "", "day": "", "era": "ac"}
    year, month, day = parsed
    body = (value or "").lstrip("-")
    parts = body.split("-")
    has_month = len(parts) >= 2 and parts[1].isdigit()
    has_day = len(parts) >= 3 and parts[2].isdigit()
    return {
        "year": str(abs(year)),
        "month": str(int(parts[1])) if has_month else "",
        "day": str(int(parts[2])) if has_day else "",
        "era": "bc" if year < 0 else "ac",
    }
