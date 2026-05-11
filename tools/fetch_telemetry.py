#!/usr/bin/env python3
"""
Telemetri sunucusundan (HTTP API) kayıtları çeker; CSV ve isteğe bağlı .mat yazar.

Gereksinimler:
  - Sadece CSV: Python 3.9+ (stdlib yeterli)
  - .mat çıktısı: pip install scipy numpy

Örnek:
  python fetch_telemetry.py --url http://127.0.0.1:1945 --out run.csv
  python fetch_telemetry.py --url http://SUNUCU_IP:1945 --since 2026-04-25T00:00:00 --limit 50000 --out data.csv
  python fetch_telemetry.py --url http://127.0.0.1:1945 --out data.csv --mat data.mat
"""

import argparse
import csv
import json
import sys
from typing import Any, Dict, List
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


CSV_COLUMNS = [
    "id",
    "received_at",
    "lon",
    "lat",
    "h",
    "m",
    "s",
    "alt",
    "gx",
    "gy",
    "gz",
    "ax",
    "ay",
    "az",
    "tmp",
    "mx",
    "my",
    "mz",
    "v",
    "i",
    "w",
    "wh",
    "spd",
    "bat",
]


def fetch_page(base_url: str, params: Dict[str, Any]) -> Dict[str, Any]:
    q = {k: v for k, v in params.items() if v is not None and v != ""}
    url = base_url.rstrip("/") + "/api/telemetry?" + urlencode(q)
    req = Request(url, headers={"Accept": "application/json"})
    with urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_all(base_url: str, since, until, page_size: int) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    offset = 0
    while True:
        data = fetch_page(
            base_url,
            {
                "since": since,
                "until": until,
                "limit": page_size,
                "offset": offset,
            },
        )
        if not data.get("ok"):
            raise RuntimeError(data.get("error", "Bilinmeyen API hatası"))
        chunk = data.get("rows") or []
        rows.extend(chunk)
        if len(chunk) < page_size:
            break
        offset += page_size
    return rows


def write_csv(path: str, rows: List[Dict[str, Any]]) -> None:
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=CSV_COLUMNS, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k, "") for k in CSV_COLUMNS})


def write_mat(path: str, rows: List[Dict[str, Any]]) -> None:
    try:
        import numpy as np
        from scipy.io import savemat
    except ImportError as e:
        print(".mat için: pip install scipy numpy", file=sys.stderr)
        raise SystemExit(1) from e

    if not rows:
        savemat(path, {"empty": np.array(1)})
        return

    out: dict = {}
    for col in CSV_COLUMNS:
        if col == "received_at":
            out[col] = np.array([str(r.get(col, "")) for r in rows], dtype=object)
        elif col == "id":
            out[col] = np.array([int(r.get(col, 0)) for r in rows], dtype=np.int64)
        else:
            vals = []
            for r in rows:
                v = r.get(col)
                vals.append(float(v) if v is not None else float("nan"))
            out[col] = np.array(vals, dtype=np.float64)

    savemat(path, out, format="5", do_compression=True)


def main() -> None:
    p = argparse.ArgumentParser(description="Telemetri sunucusundan veri çek")
    p.add_argument(
        "--url",
        default="http://127.0.0.1:1945",
        help="Sunucu kök adresi (örn: http://IP:1945)",
    )
    p.add_argument("--since", default=None, help="ISO zaman: received_at >= (opsiyonel)")
    p.add_argument("--until", default=None, help="ISO zaman: received_at <= (opsiyonel)")
    p.add_argument(
        "--limit",
        type=int,
        default=100_000,
        help="Tek istekte en fazla satır (sunucu üst sınırı 100000)",
    )
    p.add_argument(
        "--no-paginate",
        action="store_true",
        help="Tüm veriyi tek seferde çek (limit kadar); varsayılan sayfalama açık",
    )
    p.add_argument("--out", required=True, help="Çıktı CSV dosyası")
    p.add_argument("--mat", default=None, help="İsteğe bağlı .mat dosyası (scipy gerekir)")
    args = p.parse_args()

    page_size = min(max(args.limit, 1), 100_000)

    try:
        if args.no_paginate:
            data = fetch_page(
                args.url,
                {"since": args.since, "until": args.until, "limit": page_size, "offset": 0},
            )
            if not data.get("ok"):
                raise RuntimeError(data.get("error", "API hatası"))
            rows = data.get("rows") or []
        else:
            rows = fetch_all(args.url, args.since, args.until, page_size)
    except HTTPError as e:
        print(f"HTTP {e.code}: {e.reason}", file=sys.stderr)
        if e.fp:
            try:
                print(e.fp.read().decode("utf-8", errors="replace"), file=sys.stderr)
            except Exception:
                pass
        raise SystemExit(1) from e
    except URLError as e:
        print(f"Bağlantı hatası: {e}", file=sys.stderr)
        raise SystemExit(1) from e

    write_csv(args.out, rows)
    print(f"CSV yazıldı: {args.out}  ({len(rows)} satır)")

    if args.mat:
        write_mat(args.mat, rows)
        print(f"MAT yazıldı: {args.mat}")


if __name__ == "__main__":
    main()
