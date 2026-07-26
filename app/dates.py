"""Date helpers — year-only and BCE-aware, never crash on missing dates."""

from __future__ import annotations

from typing import Optional


def parse_historia_date(value: Optional[str]) -> Optional[tuple[int, int, int]]:
    """
    Parse a Historia date string into (year, month, day).

    Accepts:
      - full ISO: "1815-06-18", "-0044-03-15"
      - year-month: "1815-06", "-0044-03"
      - year-only: "1815", "-0044", "44 BCE" / "44BC" (normalized on write preferably)

    Returns None if missing or unparseable (caller sorts those to the end).
    Year may be negative for BCE.
    """
    if value is None:
        return None
    raw = value.strip()
    if not raw:
        return None

    # Soft accept "44 BCE" / "44 BC" / "44BCE"
    upper = raw.upper().replace(" ", "")
    if upper.endswith("BCE") or upper.endswith("BC"):
        digits = "".join(c for c in upper if c.isdigit())
        if not digits:
            return None
        try:
            return (-int(digits), 1, 1)
        except ValueError:
            return None

    # Leading minus for BCE ISO years
    negative = raw.startswith("-")
    body = raw[1:] if negative else raw
    parts = body.split("-")
    try:
        year = int(parts[0])
        if negative:
            year = -year
        month = int(parts[1]) if len(parts) > 1 and parts[1] else 1
        day = int(parts[2]) if len(parts) > 2 and parts[2] else 1
        # Clamp invalid month/day softly
        month = min(max(month, 1), 12)
        day = min(max(day, 1), 31)
        return (year, month, day)
    except (ValueError, IndexError):
        return None


def date_sort_key(value: Optional[str]) -> tuple:
    """
    Sort key for timeline / lists.
    Dated items first (chronological); missing/unparseable dates sort to the end.
    """
    parsed = parse_historia_date(value)
    if parsed is None:
        return (1, 0, 0, 0)  # undated last
    year, month, day = parsed
    return (0, year, month, day)


def format_display_date(value: Optional[str]) -> str:
    """Human-readable date for UI badges."""
    parsed = parse_historia_date(value)
    if parsed is None:
        return ""
    year, month, day = parsed
    if year < 0:
        label = f"{abs(year)} BCE"
    else:
        label = str(year)
    # If original had month/day precision, append lightly
    if value and value.count("-") >= 2 and not value.lstrip("-").count("-") == 0:
        body = value.lstrip("-")
        parts = body.split("-")
        if len(parts) >= 3 and parts[1] and parts[2]:
            return f"{parts[1]}/{parts[2]}/{label}"
        if len(parts) >= 2 and parts[1]:
            return f"{parts[1]}/{label}"
    return label


def format_date_range(start: Optional[str], end: Optional[str]) -> str:
    a = format_display_date(start)
    b = format_display_date(end)
    if a and b:
        return f"{a} – {b}"
    return a or b or ""
