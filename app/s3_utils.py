import os
from datetime import datetime, timedelta, timezone
import re
from typing import Dict, List, Optional, Tuple

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError


def get_allowed_buckets() -> List[str]:
    buckets_env = os.getenv("S3_BUCKETS", "").strip()
    if not buckets_env:
        return []
    return [b.strip() for b in buckets_env.split(",") if b.strip()]


def _csv_env(*names: str) -> Optional[List[str]]:
    for n in names:
        v = os.getenv(n)
        if v and v.strip():
            return [s.strip() for s in v.split(",") if s.strip()]
    return None


def _single_env(*names: str) -> Optional[str]:
    for n in names:
        v = os.getenv(n)
        if v and v.strip():
            return v.strip()
    return None


def get_s3_clients() -> List:
    """
    Build one or more S3 clients targeting Hetzner (or any S3-compatible).

    Plural (comma-separated) envs are preferred; singular envs are supported
    for backward compatibility.

    Plural envs (first match wins):
    - Endpoints: S3_ENDPOINT_URLS, S3_ENDPOINTS, S3_URLS, urls
    - Access keys: S3_ACCESS_KEY_IDS, S3_ACCESS_KEYS, s3keys
    - Secret keys: S3_SECRET_ACCESS_KEYS, S3_SECRET_KEYS, s3accessekys
    - Region: S3_REGIONS (optional)

    Singular fallback:
    - Endpoint: S3_ENDPOINT_URL, S3_ENDPOINT, S3_URL, url
    - Access key: S3_ACCESS_KEY_ID, S3_ACCESS_KEY, s3key
    - Secret key: S3_SECRET_ACCESS_KEY, S3_SECRET_KEY, s3accesseky, S3_ACCESS_SECRET
    - Region: S3_REGION, AWS_REGION, AWS_DEFAULT_REGION
    """
    endpoints = _csv_env("S3_ENDPOINT_URLS", "S3_ENDPOINTS", "S3_URLS", "urls")
    access_keys = _csv_env("S3_ACCESS_KEY_IDS", "S3_ACCESS_KEYS", "s3keys")
    secret_keys = _csv_env("S3_SECRET_ACCESS_KEYS", "S3_SECRET_KEYS", "s3accessekys")
    regions = _csv_env("S3_REGIONS")

    # If plural not set, try singular envs and create one client
    if not (endpoints or access_keys or secret_keys):
        endpoint = _single_env("S3_ENDPOINT_URL", "S3_ENDPOINT", "S3_URL", "url")
        access_key = _single_env("S3_ACCESS_KEY_ID", "S3_ACCESS_KEY", "s3key")
        secret_key = _single_env("S3_SECRET_ACCESS_KEY", "S3_SECRET_KEY", "s3accesseky", "S3_ACCESS_SECRET")
        region = _single_env("S3_REGION", "AWS_REGION", "AWS_DEFAULT_REGION") or "us-east-1"
        session = boto3.session.Session()
        return [
            session.client(
                "s3",
                endpoint_url=endpoint,
                aws_access_key_id=access_key,
                aws_secret_access_key=secret_key,
                region_name=region,
                config=Config(
                    region_name=region,
                    signature_version="s3v4",
                    s3={"addressing_style": "path"},
                    retries={"max_attempts": 10},
                ),
            )
        ]

    # Use plural lists; zip by index, stopping at shortest list if needed
    clients: List = []
    count = 0
    if endpoints and access_keys and secret_keys:
        count = min(len(endpoints), len(access_keys), len(secret_keys))
    elif endpoints and access_keys:
        count = min(len(endpoints), len(access_keys))
    elif endpoints and secret_keys:
        count = min(len(endpoints), len(secret_keys))
    elif access_keys and secret_keys:
        count = min(len(access_keys), len(secret_keys))
    else:
        # If only one of lists is provided, treat them as a single value list
        endpoints = endpoints or [None]
        access_keys = access_keys or [None]
        secret_keys = secret_keys or [None]
        count = 1

    for i in range(count):
        endpoint = endpoints[i] if endpoints else None
        access_key = access_keys[i] if access_keys else None
        secret_key = secret_keys[i] if secret_keys else None
        region = (regions[i] if regions and i < len(regions) else None) or _single_env(
            "S3_REGION", "AWS_REGION", "AWS_DEFAULT_REGION"
        ) or "us-east-1"
        session = boto3.session.Session()
        clients.append(
            session.client(
                "s3",
                endpoint_url=endpoint,
                aws_access_key_id=access_key,
                aws_secret_access_key=secret_key,
                region_name=region,
                config=Config(
                    region_name=region,
                    signature_version="s3v4",
                    s3={"addressing_style": "path"},
                    retries={"max_attempts": 10},
                ),
            )
        )

    return clients


def _client_for_bucket(bucket: str):
    """Return the first client that can access the given bucket via HeadBucket."""
    last_exc = None
    for c in get_s3_clients():
        try:
            c.head_bucket(Bucket=bucket)
            return c
        except ClientError as e:
            last_exc = e
            continue
        except Exception as e:  # network or other errors
            last_exc = e
            continue
    if last_exc:
        raise last_exc
    raise RuntimeError("No S3 clients configured")


def client_for_bucket(bucket: str):
    """Public wrapper to resolve an S3 client for a given bucket."""
    return _client_for_bucket(bucket)


def list_objects_page(
    bucket: str,
    prefix: Optional[str] = None,
    continuation_token: Optional[str] = None,
    delimiter: str = "/",
) -> Dict:
    s3 = _client_for_bucket(bucket)
    kwargs = {"Bucket": bucket, "Delimiter": delimiter, "MaxKeys": 500}
    if prefix:
        kwargs["Prefix"] = prefix
    if continuation_token:
        kwargs["ContinuationToken"] = continuation_token

    resp = s3.list_objects_v2(**kwargs)
    folders = [p.get("Prefix") for p in resp.get("CommonPrefixes", [])]
    objects: List[Dict] = []
    for o in resp.get("Contents", []):
        key = o.get("Key")
        if not key:
            continue
        # Ignore S3 folder placeholder objects (keys ending with '/' or equal to the prefix)
        if key.endswith("/"):
            continue
        if prefix and key == prefix:
            continue
        objects.append(
            {
                "key": key,
                "size": o.get("Size", 0),
                "last_modified": o.get("LastModified").isoformat() if o.get("LastModified") else None,
                "storage_class": o.get("StorageClass"),
            }
        )

    return {
        "prefix": prefix or "",
        "folders": folders,
        "objects": objects,
        "is_truncated": resp.get("IsTruncated", False),
        "next_token": resp.get("NextContinuationToken"),
    }


def delete_all_objects(bucket: str) -> Dict:
    s3 = _client_for_bucket(bucket)
    paginator = s3.get_paginator("list_objects_v2")
    deleted = 0
    batches = 0

    try:
        for page in paginator.paginate(Bucket=bucket):
            contents = page.get("Contents", [])
            if not contents:
                continue
            to_delete = [{"Key": o["Key"]} for o in contents]
            # Delete in chunks of up to 1000
            for i in range(0, len(to_delete), 1000):
                chunk = to_delete[i : i + 1000]
                resp = s3.delete_objects(Bucket=bucket, Delete={"Objects": chunk, "Quiet": True})
                deleted += len(resp.get("Deleted", []))
                batches += 1

        return {"deleted": deleted, "batches": batches}
    except ClientError as e:
        return {"error": str(e), "deleted": deleted, "batches": batches}


def cleanup_old_objects(bucket: str, days: int = 30) -> Dict:
    s3 = _client_for_bucket(bucket)
    paginator = s3.get_paginator("list_objects_v2")
    threshold = datetime.now(timezone.utc) - timedelta(days=days)
    deleted = 0
    scanned = 0
    batches = 0

    try:
        for page in paginator.paginate(Bucket=bucket):
            contents = page.get("Contents", [])
            if not contents:
                continue
            old_keys = [
                {"Key": o["Key"]}
                for o in contents
                if o.get("LastModified") and o["LastModified"] < threshold
            ]
            scanned += len(contents)
            if not old_keys:
                continue

            for i in range(0, len(old_keys), 1000):
                chunk = old_keys[i : i + 1000]
                resp = s3.delete_objects(Bucket=bucket, Delete={"Objects": chunk, "Quiet": True})
                deleted += len(resp.get("Deleted", []))
                batches += 1

        return {"deleted": deleted, "scanned": scanned, "batches": batches, "days": days}
    except ClientError as e:
        return {"error": str(e), "deleted": deleted, "scanned": scanned, "batches": batches, "days": days}


def cleanup_candidates(bucket: str, days: int = 30, prefix: Optional[str] = None) -> Dict:
    """Return objects older than threshold as candidates for deletion.
    Optionally filter by Prefix.
    """
    s3 = _client_for_bucket(bucket)
    paginator = s3.get_paginator("list_objects_v2")
    threshold = datetime.now(timezone.utc) - timedelta(days=days)
    candidates: List[Dict] = []
    scanned = 0
    kwargs = {"Bucket": bucket}
    if prefix:
        kwargs["Prefix"] = prefix
    for page in paginator.paginate(**kwargs):
        contents = page.get("Contents", [])
        scanned += len(contents)
        for o in contents:
            lm = o.get("LastModified")
            key = o.get("Key")
            # Ignore folder placeholders
            if key and key.endswith("/"):
                continue
            if lm and lm < threshold:
                candidates.append({
                    "key": key,
                    "size": o.get("Size", 0),
                    "last_modified": lm.isoformat(),
                })
    return {"prefix": prefix or "", "days": days, "scanned": scanned, "candidates": candidates}


def count_prefix(bucket: str, prefix: Optional[str] = None) -> Dict:
    """Count direct children in a prefix (non-recursive): files and folders.
    Uses Delimiter '/' to stay at current level and paginates across results.
    """
    s3 = _client_for_bucket(bucket)
    paginator = s3.get_paginator("list_objects_v2")
    kwargs = {"Bucket": bucket, "Delimiter": "/"}
    if prefix:
        kwargs["Prefix"] = prefix
    files = 0
    folders = 0
    for page in paginator.paginate(**kwargs):
        folders += len(page.get("CommonPrefixes", []))
        for o in page.get("Contents", []):
            key = o.get("Key")
            if not key:
                continue
            if key.endswith("/"):
                continue
            if prefix and key == prefix:
                continue
            files += 1
    return {"prefix": prefix or "", "files": files, "folders": folders}


def smart_cleanup(bucket: str, prefix: Optional[str] = None, dry_run: bool = False) -> Dict:
    """
    Apply tiered retention on objects under a prefix:
    - < 7 days: keep 1 per hour
    - 7–30 days: keep 1 per day
    - 30–365 days: keep 1 per 7 days (weekly via ISO week)
    - >= 365 days: keep 1 per month

    Returns summary of scanned/kept/deleted.
    """
    s3 = _client_for_bucket(bucket)
    paginator = s3.get_paginator("list_objects_v2")
    now = datetime.now(timezone.utc)
    scanned = 0

    # Gather all objects in prefix (non-delimited, recursive)
    objects = []
    for page in paginator.paginate(Bucket=bucket, Prefix=(prefix or "")):
        contents = page.get("Contents", [])
        for o in contents:
            key = o.get("Key")
            if not key or key.endswith("/"):
                continue
            lm = o.get("LastModified")
            if not lm:
                continue
            size = o.get("Size", 0)
            objects.append({"key": key, "last_modified": lm, "size": size})
        scanned += len(contents)

    # Sort by last modified to help select latest per bucket
    objects.sort(key=lambda x: x["last_modified"])  # ascending

    def tier_and_bucket(dt: datetime) -> Tuple[str, str]:
        age = now - dt
        days = age.total_seconds() / 86400
        if days < 7:
            # hourly
            bucket_id = dt.replace(minute=0, second=0, microsecond=0).strftime("%Y-%m-%dT%H:00Z")
            return ("hourly", bucket_id)
        elif days < 30:
            # daily
            bucket_id = dt.date().strftime("%Y-%m-%d")
            return ("daily", bucket_id)
        elif days < 90:
            # weekly (ISO week) for 1–3 months
            iso_year, iso_week, _ = dt.isocalendar()
            bucket_id = f"{iso_year}-W{iso_week:02d}"
            return ("weekly", bucket_id)
        elif days < 365:
            # biweekly (every 2 ISO weeks) for >3 months and <1 year
            iso_year, iso_week, _ = dt.isocalendar()
            biweek = (iso_week - 1) // 2 + 1  # 1..26 or 27
            bucket_id = f"{iso_year}-BW{biweek:02d}"
            return ("biweekly", bucket_id)
        else:
            # monthly for >= 1 year
            bucket_id = dt.strftime("%Y-%m")
            return ("monthly", bucket_id)

    # Pick the newest object per (tier,bucket_id)
    keep_by_bucket: Dict[str, Dict] = {}
    for obj in objects:
        tier, bid = tier_and_bucket(obj["last_modified"])
        k = f"{tier}:{bid}"
        prev = keep_by_bucket.get(k)
        if prev is None or obj["last_modified"] > prev["last_modified"]:
            keep_by_bucket[k] = obj

    keep_keys = {v["key"] for v in keep_by_bucket.values()}
    to_delete = [o for o in objects if o["key"] not in keep_keys]

    deleted = 0
    batches = 0
    if not dry_run and to_delete:
        for i in range(0, len(to_delete), 1000):
            chunk = to_delete[i : i + 1000]
            resp = s3.delete_objects(
                Bucket=bucket,
                Delete={"Objects": [{"Key": o["key"]} for o in chunk], "Quiet": True},
            )
            deleted += len(resp.get("Deleted", []))
            batches += 1

    result = {
        "prefix": prefix or "",
        "scanned": len(objects),
        "kept": len(keep_keys),
        "to_delete": len(to_delete),
        "deleted": deleted,
        "batches": batches,
        "policy": {
            "hourly": "< 7 days",
            "daily": "7–30 days",
            "weekly": "30–90 days",
            "biweekly": "90–365 days",
            "monthly": ">= 365 days",
        },
        # full candidate list for preview/approval
        "candidates": [
            {"key": o["key"], "size": o["size"], "last_modified": o["last_modified"].isoformat()}
            for o in to_delete
        ],
    }
    return result


def delete_keys(bucket: str, keys: List[str]) -> Dict:
    """Delete provided keys in chunks of 1000."""
    if not keys:
        return {"deleted": 0, "batches": 0}
    s3 = _client_for_bucket(bucket)
    deleted = 0
    batches = 0
    errors: List[Dict] = []
    for i in range(0, len(keys), 1000):
        chunk = keys[i : i + 1000]
        resp = s3.delete_objects(Bucket=bucket, Delete={"Objects": [{"Key": k} for k in chunk], "Quiet": True})
        deleted += len(resp.get("Deleted", []))
        batches += 1
        errs = resp.get("Errors", [])
        for e in errs:
            errors.append({"key": e.get("Key"), "code": e.get("Code"), "message": e.get("Message")})
    result = {"deleted": deleted, "batches": batches}
    if errors:
        result["errors"] = errors
    return result


def delete_prefix(bucket: str, prefix: str) -> Dict:
    """Delete all objects under a prefix (recursive)."""
    s3 = _client_for_bucket(bucket)
    paginator = s3.get_paginator("list_objects_v2")
    deleted = 0
    batches = 0
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        contents = page.get("Contents", [])
        if not contents:
            continue
        keys = [{"Key": o["Key"]} for o in contents]
        for i in range(0, len(keys), 1000):
            chunk = keys[i : i + 1000]
            resp = s3.delete_objects(Bucket=bucket, Delete={"Objects": chunk, "Quiet": True})
            deleted += len(resp.get("Deleted", []))
            batches += 1
    return {"deleted": deleted, "batches": batches}


def delete_prefixes(bucket: str, prefixes: List[str]) -> Dict:
    total_deleted = 0
    total_batches = 0
    for p in prefixes:
        res = delete_prefix(bucket, p)
        total_deleted += res.get("deleted", 0)
        total_batches += res.get("batches", 0)
    return {"deleted": total_deleted, "batches": total_batches, "prefixes": len(prefixes)}


_TS_PATTERNS = [
    # ISO-like
    (re.compile(r"^(\d{4})-(\d{2})-(\d{2})[T_](\d{2}):(\d{2}):(\d{2})$"), "%Y-%m-%dT%H:%M:%S"),
    (re.compile(r"^(\d{4})-(\d{2})-(\d{2})[T_](\d{2})-(\d{2})-(\d{2})$"), "%Y-%m-%d_%H-%M-%S"),
    (re.compile(r"^(\d{4})-(\d{2})-(\d{2})[T_](\d{2}):(\d{2})$"), "%Y-%m-%dT%H:%M"),
    (re.compile(r"^(\d{4})(\d{2})(\d{2})[T_]?(\d{2})(\d{2})(\d{2})$"), "%Y%m%d%H%M%S"),
    (re.compile(r"^(\d{4})(\d{2})(\d{2})$"), "%Y%m%d"),
    (re.compile(r"^(\d{4})-(\d{2})-(\d{2})$"), "%Y-%m-%d"),
]


def _parse_timestamp(name: str) -> Optional[datetime]:
    """
    Extract a timestamp from an arbitrary folder name. Prefers the last
    timestamp-looking substring to avoid matching IDs earlier in the name.

    Supported inside-string patterns (examples):
    - 2025-05-02_06-17-48  -> "%Y-%m-%d %H-%M-%S"
    - 2025-05-02_06-17     -> "%Y-%m-%d %H-%M"
    - 2025-05-02T06:17:48  -> "%Y-%m-%dT%H:%M:%S"
    - 20250502T061748      -> "%Y%m%dT%H%M%S"
    - 20250502             -> "%Y%m%d"
    - 2025-05-02           -> "%Y-%m-%d"
    """
    s = name.strip().rstrip("/")

    # Try patterns with date and time (with seconds)
    pats = [
        # YYYY-MM-DD[_|T]HH-MM-SS
        (re.compile(r"(\d{4}-\d{2}-\d{2})[T_](\d{2})-(\d{2})-(\d{2})"), "ymd_hms_dash"),
        # YYYY-MM-DD[_|T]HH:MM:SS
        (re.compile(r"(\d{4}-\d{2}-\d{2})[T_](\d{2}):(\d{2}):(\d{2})"), "ymd_hms_colon"),
        # YYYY-MM-DD[_|T]HH-MM
        (re.compile(r"(\d{4}-\d{2}-\d{2})[T_](\d{2})-(\d{2})(?![-:\d])"), "ymd_hm_dash"),
        # YYYYMMDD[T]?HHMMSS
        (re.compile(r"(\d{8})[T_]?(\d{6})"), "ymd_compact_hms"),
        # YYYYMMDD
        (re.compile(r"(\d{8})(?!\d)"), "ymd_compact"),
        # YYYY-MM-DD
        (re.compile(r"(\d{4}-\d{2}-\d{2})(?![\dT_])"), "ymd"),
    ]

    for rx, kind in pats:
        m = None
        # Find the last occurrence to prefer trailing timestamp
        matches = list(rx.finditer(s))
        if matches:
            m = matches[-1]
        if not m:
            continue
        try:
            if kind == "ymd_hms_dash":
                ymd, hh, mm, ss = m.groups()
                dt = datetime.strptime(f"{ymd}T{hh}:{mm}:{ss}", "%Y-%m-%dT%H:%M:%S")
            elif kind == "ymd_hms_colon":
                ymd, hh, mm, ss = m.groups()
                dt = datetime.strptime(f"{ymd}T{hh}:{mm}:{ss}", "%Y-%m-%dT%H:%M:%S")
            elif kind == "ymd_hm_dash":
                ymd, hh, mm = m.groups()
                dt = datetime.strptime(f"{ymd}T{hh}:{mm}", "%Y-%m-%dT%H:%M")
            elif kind == "ymd_compact_hms":
                ymd, hms = m.groups()
                dt = datetime.strptime(f"{ymd}T{hms}", "%Y%m%dT%H%M%S")
            elif kind == "ymd_compact":
                (ymd,) = m.groups()
                dt = datetime.strptime(ymd, "%Y%m%d")
            else:  # "ymd"
                (ymd,) = m.groups()
                dt = datetime.strptime(ymd, "%Y-%m-%d")
            return dt.replace(tzinfo=timezone.utc)
        except Exception:
            continue

    return None


def smart_cleanup_folders(bucket: str, parent_prefix: Optional[str] = None, dry_run: bool = False) -> Dict:
    """Apply tiered retention on direct subfolders under parent_prefix using folder name timestamps.

    Only subfolders whose trailing segment parses to a timestamp are considered.
    Deletion removes all objects under the selected prefixes.
    """
    s3 = _client_for_bucket(bucket)
    paginator = s3.get_paginator("list_objects_v2")
    now = datetime.now(timezone.utc)

    kwargs = {"Bucket": bucket, "Delimiter": "/"}
    if parent_prefix:
        kwargs["Prefix"] = parent_prefix

    # Gather subfolders
    folders: List[Dict] = []
    scanned = 0
    for page in paginator.paginate(**kwargs):
        cps = page.get("CommonPrefixes", [])
        scanned += len(cps)
        for cp in cps:
            pfx = cp.get("Prefix")
            if not pfx:
                continue
            name = pfx
            if parent_prefix and pfx.startswith(parent_prefix):
                name = pfx[len(parent_prefix):]
            name = name.rstrip("/")
            ts = _parse_timestamp(name)
            if not ts:
                continue  # skip non-timestamped folders
            folders.append({"prefix": pfx, "ts": ts})

    # Sort by ts for deterministic keep selection
    folders.sort(key=lambda x: x["ts"])  # ascending

    def tier_and_bucket(dt: datetime) -> Tuple[str, str]:
        age = now - dt
        days = age.total_seconds() / 86400
        if days < 7:
            bucket_id = dt.replace(minute=0, second=0, microsecond=0).strftime("%Y-%m-%dT%H:00Z")
            return ("hourly", bucket_id)
        elif days < 30:
            bucket_id = dt.date().strftime("%Y-%m-%d")
            return ("daily", bucket_id)
        elif days < 90:
            iso_year, iso_week, _ = dt.isocalendar()
            bucket_id = f"{iso_year}-W{iso_week:02d}"
            return ("weekly", bucket_id)
        elif days < 365:
            iso_year, iso_week, _ = dt.isocalendar()
            biweek = (iso_week - 1) // 2 + 1
            bucket_id = f"{iso_year}-BW{biweek:02d}"
            return ("biweekly", bucket_id)
        else:
            bucket_id = dt.strftime("%Y-%m")
            return ("monthly", bucket_id)

    keep_by_bucket: Dict[str, Dict] = {}
    for item in folders:
        tier, bid = tier_and_bucket(item["ts"])
        k = f"{tier}:{bid}"
        prev = keep_by_bucket.get(k)
        if prev is None or item["ts"] > prev["ts"]:
            keep_by_bucket[k] = item

    keep_prefixes = {v["prefix"] for v in keep_by_bucket.values()}
    to_delete = [f for f in folders if f["prefix"] not in keep_prefixes]

    deleted = 0
    batches = 0
    if not dry_run and to_delete:
        for chunk_start in range(0, len(to_delete), 50):  # delete 50 folders per batch loop
            chunk = to_delete[chunk_start:chunk_start+50]
            res = delete_prefixes(bucket, [c["prefix"] for c in chunk])
            deleted += res.get("deleted", 0)
            batches += res.get("batches", 0)

    return {
        "prefix": parent_prefix or "",
        "scanned_folders": scanned,
        "considered_folders": len(folders),
        "kept": len(keep_prefixes),
        "to_delete": len(to_delete),
        "deleted": deleted,
        "batches": batches,
        "policy": {
            "hourly": "< 7 days",
            "daily": "7–30 days",
            "weekly": "30–90 days",
            "biweekly": "90–365 days",
            "monthly": ">= 365 days",
        },
        "candidates": [
            {"key": f["prefix"], "last_modified": f["ts"].isoformat(), "size": None}
            for f in to_delete
        ],
    }
