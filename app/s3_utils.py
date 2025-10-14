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


def get_s3_client():
    region = os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION")
    # S3 is global, but region can help with IAM/endpoint routing
    if region:
        return boto3.client("s3", config=Config(region_name=region, retries={"max_attempts": 10}))
    return boto3.client("s3", config=Config(retries={"max_attempts": 10}))


def list_objects_page(
    bucket: str,
    prefix: Optional[str] = None,
    continuation_token: Optional[str] = None,
    delimiter: str = "/",
) -> Dict:
    s3 = get_s3_client()
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
    s3 = get_s3_client()
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
    s3 = get_s3_client()
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

