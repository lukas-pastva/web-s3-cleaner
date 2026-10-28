import os
import re
import hashlib
from urllib.parse import quote
from botocore.exceptions import ClientError
from flask import Flask, jsonify, request, render_template, Response, stream_with_context
from .s3_utils import (
    get_allowed_buckets,
    list_objects_page,
    delete_all_objects,
    smart_cleanup,
    delete_keys,
    client_for_bucket,
    delete_prefixes,
    smart_cleanup_folders,
)


def create_app():
    app = Flask(__name__, static_folder="static", static_url_path="/static")

    # Compute simple content hashes for static assets to use as cache-busting query params
    def _asset_hash(filename: str) -> str:
        path = os.path.join(app.static_folder, filename)
        try:
            h = hashlib.md5()
            with open(path, "rb") as f:
                for chunk in iter(lambda: f.read(8192), b""):
                    h.update(chunk)
            return h.hexdigest()[:10]
        except Exception:
            try:
                return str(int(os.path.getmtime(path)))
            except Exception:
                return "dev"

    asset_ver = {fn: _asset_hash(fn) for fn in ("styles.css", "app.js", "logo.svg")}

    @app.get("/api/healthz")
    def healthz():
        return jsonify({"status": "ok"})

    @app.get("/api/buckets")
    def list_buckets():
        buckets = get_allowed_buckets()
        return jsonify({"buckets": buckets})

    def _ensure_allowed(bucket: str):
        allowed = set(get_allowed_buckets())
        if bucket not in allowed:
            return False
        return True

    @app.get("/api/buckets/<bucket>/list")
    def list_bucket_contents(bucket):
        if not _ensure_allowed(bucket):
            return jsonify({"error": "Bucket not allowed"}), 400
        prefix = request.args.get("prefix") or None
        token = request.args.get("token") or None
        try:
            data = list_objects_page(bucket=bucket, prefix=prefix, continuation_token=token)
            return jsonify(data)
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    @app.post("/api/buckets/<bucket>/delete-all")
    def delete_all(bucket):
        if not _ensure_allowed(bucket):
            return jsonify({"error": "Bucket not allowed"}), 400
        result = delete_all_objects(bucket)
        code = 200 if "error" not in result else 500
        return jsonify(result), code

    # Removed legacy 30+ days cleanup endpoints

    @app.post("/api/buckets/<bucket>/smart-cleanup")
    def smart_cleanup_route(bucket):
        if not _ensure_allowed(bucket):
            return jsonify({"error": "Bucket not allowed"}), 400
        prefix = request.args.get("prefix") or None
        dry_run = request.args.get("dry_run", default="0") in ("1", "true", "True")
        try:
            result = smart_cleanup(bucket=bucket, prefix=prefix, dry_run=dry_run)
            code = 200 if "error" not in result else 500
            return jsonify(result), code
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    @app.get("/api/buckets/<bucket>/smart-cleanup-preview")
    def smart_cleanup_preview(bucket):
        if not _ensure_allowed(bucket):
            return jsonify({"error": "Bucket not allowed"}), 400
        prefix = request.args.get("prefix") or None
        try:
            result = smart_cleanup(bucket=bucket, prefix=prefix, dry_run=True)
            # Ensure we don't return deletion counts when dry-run
            result.pop("deleted", None)
            result.pop("batches", None)
            return jsonify(result)
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    @app.post("/api/buckets/<bucket>/delete-keys")
    def delete_keys_route(bucket):
        if not _ensure_allowed(bucket):
            return jsonify({"error": "Bucket not allowed"}), 400
        try:
            payload = request.get_json(force=True, silent=True) or {}
            keys = payload.get("keys") or []
            if not isinstance(keys, list) or not all(isinstance(k, str) for k in keys):
                return jsonify({"error": "Invalid or missing 'keys' list"}), 400
            result = delete_keys(bucket=bucket, keys=keys)
            return jsonify(result)
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    @app.post("/api/buckets/<bucket>/delete-prefixes")
    def delete_prefixes_route(bucket):
        if not _ensure_allowed(bucket):
            return jsonify({"error": "Bucket not allowed"}), 400
        try:
            payload = request.get_json(force=True, silent=True) or {}
            prefixes = payload.get("prefixes") or []
            if isinstance(prefixes, str):
                prefixes = [prefixes]
            if not isinstance(prefixes, list) or not all(isinstance(p, str) for p in prefixes):
                return jsonify({"error": "Invalid or missing 'prefixes' list"}), 400
            result = delete_prefixes(bucket=bucket, prefixes=prefixes)
            return jsonify(result)
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    @app.get("/api/buckets/<bucket>/smart-cleanup-folders-preview")
    def smart_cleanup_folders_preview(bucket):
        if not _ensure_allowed(bucket):
            return jsonify({"error": "Bucket not allowed"}), 400
        prefix = request.args.get("prefix") or None
        try:
            result = smart_cleanup_folders(bucket=bucket, parent_prefix=prefix, dry_run=True)
            result.pop("deleted", None)
            result.pop("batches", None)
            return jsonify(result)
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    @app.get("/api/buckets/<bucket>/counts")
    def counts(bucket):
        if not _ensure_allowed(bucket):
            return jsonify({"error": "Bucket not allowed"}), 400
        prefix = request.args.get("prefix") or None
        from .s3_utils import count_prefix
        try:
            result = count_prefix(bucket=bucket, prefix=prefix)
            return jsonify(result)
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    @app.get("/")
    def index():
        return render_template("index.html", asset_ver=asset_ver)

    # SPA routes to enable shareable URLs for bucket/prefix
    @app.get("/b/<bucket>")
    def spa_bucket(bucket):
        return render_template("index.html", asset_ver=asset_ver)

    @app.get("/b/<bucket>/p/<path:prefix>")
    def spa_prefix(bucket, prefix):
        return render_template("index.html", asset_ver=asset_ver)

    @app.get("/api/buckets/<bucket>/download")
    def download_object(bucket):
        """Stream the object through this app (proxy download).

        Until 2026-10 this answered with a 302 redirect to a presigned S3 URL, so the
        browser fetched the file straight from the S3 endpoint (e.g.
        hel1.your-objectstorage.com). Some client machines do not trust that
        endpoint's certificate chain (NET::ERR_CERT_AUTHORITY_INVALID) and the
        download failed. Proxying the bytes means the browser only ever talks to
        this app's own domain, which is already behind oauth2 and a trusted cert.
        """
        if not _ensure_allowed(bucket):
            return jsonify({"error": "Bucket not allowed"}), 400
        key = request.args.get("key")
        if not key:
            return jsonify({"error": "Missing key"}), 400
        disposition = request.args.get("disposition", default="attachment")
        if disposition not in ("attachment", "inline"):
            disposition = "attachment"
        try:
            s3 = client_for_bucket(bucket)
            obj = s3.get_object(Bucket=bucket, Key=key)
        except ClientError as e:
            code = (getattr(e, "response", None) or {}).get("Error", {}).get("Code", "")
            if code in ("NoSuchKey", "NotFound", "404"):
                return jsonify({"error": "Object not found"}), 404
            return jsonify({"error": str(e)}), 500
        except Exception as e:
            return jsonify({"error": str(e)}), 500

        filename = key.split("/")[-1] or "download"
        # ASCII fallback for old clients + RFC 5987 UTF-8 name; strip CR/LF/quotes (header safety)
        ascii_name = re.sub(r'[\r\n"]', "", filename.encode("ascii", "replace").decode("ascii"))
        content_disposition = f"{disposition}; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}"

        body = obj["Body"]

        def generate():
            try:
                for chunk in body.iter_chunks(chunk_size=1024 * 1024):
                    yield chunk
            finally:
                try:
                    body.close()
                except Exception:
                    pass

        headers = {
            "Content-Disposition": content_disposition,
            "Content-Type": obj.get("ContentType") or "application/octet-stream",
            "Cache-Control": "no-store",
        }
        if obj.get("ContentLength") is not None:
            headers["Content-Length"] = str(obj["ContentLength"])
        return Response(stream_with_context(generate()), headers=headers)

    return app


app = create_app()

if __name__ == "__main__":
    port = int(os.getenv("PORT", "8000"))
    app.run(host="0.0.0.0", port=port)
