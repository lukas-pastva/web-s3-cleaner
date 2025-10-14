Web S3 Cleaner
===============

Simple web app to browse configured S3 buckets and run cleanup actions:
- Browse objects (with folder-like prefixes)
- Delete ALL objects in a bucket (triple-confirmed in UI)
- Cleanup objects older than 30 days

Configuration
-------------
- `S3_BUCKETS`: Comma-separated list of allowed bucket names (e.g. `bucket-a,bucket-b`).
- Hetzner S3-compatible settings now support multiple endpoints/credentials via comma-separated env vars (plural). The app will attempt each configured client until it finds access to the selected bucket:
  - Endpoints: `S3_ENDPOINT_URLS` (preferred) or `S3_ENDPOINTS` or `S3_URLS` or `urls`
  - Access keys: `S3_ACCESS_KEY_IDS` (preferred) or `S3_ACCESS_KEYS` or `s3keys`
  - Secret keys: `S3_SECRET_ACCESS_KEYS` (preferred) or `S3_SECRET_KEYS` or `s3accessekys`
  - Regions (optional): `S3_REGIONS` (comma-separated). If fewer regions are provided, remaining clients default to `S3_REGION`/`AWS_REGION`/`AWS_DEFAULT_REGION` or `us-east-1`.
  - You may still use the singular forms (`S3_ENDPOINT_URL`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`) to define a single client.
  - Addressing style is path-style; SigV4 is used.

Run locally
-----------
1. Install dependencies: `pip install -r requirements.txt`
2. Export env vars (single or multiple credentials):
   - `export S3_BUCKETS="bucket-a,bucket-b"`
   - Single set example:
     - `export S3_ENDPOINT_URL="https://s3.<region>.hetzner.cloud"`
     - `export S3_ACCESS_KEY_ID=...`
     - `export S3_SECRET_ACCESS_KEY=...`
   - Multiple sets example (comma-separated, aligned by index):
     - `export S3_ENDPOINT_URLS="https://s3.eu-central-1.hetzner.cloud,https://s3.us-east-1.hetzner.cloud"`
     - `export S3_ACCESS_KEY_IDS="key1,key2"`
     - `export S3_SECRET_ACCESS_KEYS="secret1,secret2"`
     - `export S3_REGIONS="eu-central,us-east-1"` # optional
3. Start dev server: `python -m app.server` then open `http://localhost:8000`.

Docker
------
Build and run:

```bash
docker build -t web-s3-cleaner:local .
docker run --rm -p 8000:8000 \
  -e S3_BUCKETS="bucket-a,bucket-b" \
  -e S3_ENDPOINT_URLS="https://s3.eu-central-1.hetzner.cloud,https://s3.us-east-1.hetzner.cloud" \
  -e S3_ACCESS_KEY_IDS="key1,key2" \
  -e S3_SECRET_ACCESS_KEYS="secret1,secret2" \
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
- Security: This app has no auth. Restrict network access (e.g., only within cluster) or put behind an auth proxy.
