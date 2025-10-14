Web S3 Cleaner
===============

Simple web app to browse configured S3 buckets and run cleanup actions:
- Browse objects (with folder-like prefixes)
- Delete ALL objects in a bucket (triple-confirmed in UI)
- Cleanup objects older than 30 days

Configuration
-------------
- `S3_BUCKETS`: Comma-separated list of allowed bucket names (e.g. `bucket-a,bucket-b`).
- `AWS_REGION` (optional): Region for AWS client (helps with IAM/endpoint routing).
- AWS credentials should be provided via the environment, EC2/EKS IAM roles, or IRSA.

Run locally
-----------
1. Install dependencies: `pip install -r requirements.txt`
2. Export env vars:
   - `export S3_BUCKETS="bucket-a,bucket-b"`
   - `export AWS_REGION=us-east-1`
   - Provide credentials (e.g., `aws configure`, or `AWS_ACCESS_KEY_ID`, etc.).
3. Start dev server: `python -m app.server` then open `http://localhost:8000`.

Docker
------
Build and run:

```bash
docker build -t web-s3-cleaner:local .
docker run --rm -p 8000:8000 \
  -e S3_BUCKETS="bucket-a,bucket-b" \
  -e AWS_REGION="us-east-1" \
  -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_SESSION_TOKEN \
  web-s3-cleaner:local
```

Kubernetes
----------
1. Update image and env in `k8s/deployment.yaml`.
2. Apply manifests:

```bash
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml
```

Notes
-----
- Triple confirmation for Delete ALL: two confirms + type bucket name.
- Cleanup deletes objects with `LastModified < now - 30 days`.
- Large buckets: operations can take time; backend runs synchronously. For very large buckets, consider adding background jobs and progress tracking.
- Security: This app has no auth. Restrict network access (e.g., only within cluster) or front behind an auth proxy.

