import os
from datetime import datetime, timedelta, timezone
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


def list_objects_page(
    bucket: str,
    prefix: Optional[str] = None,
    continuation_token: Optional[str] = None,
    delimiter: str = "/",
) -> Dict:
    s3 = _client_for_bucket(bucket)
    kwargs = {"Bucket": bucket, "Delimiter": delimiter}
    if prefix:
        kwargs["Prefix"] = prefix
    if continuation_token:
        kwargs["ContinuationToken"] = continuation_token

    resp = s3.list_objects_v2(**kwargs)
    folders = [p.get("Prefix") for p in resp.get("CommonPrefixes", [])]
    objects = [
        {
            "key": o["Key"],
            "size": o.get("Size", 0),
            "last_modified": o.get("LastModified").isoformat() if o.get("LastModified") else None,
            "storage_class": o.get("StorageClass"),
        }
        for o in resp.get("Contents", [])
    ]

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
        # return sample keys for preview/debug (capped)
        "sample_delete_keys": [o["key"] for o in to_delete[:20]],
    }
    return result
