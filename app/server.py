import os
from flask import Flask, jsonify, request, send_from_directory, redirect
from .s3_utils import (
    get_allowed_buckets,
    list_objects_page,
    delete_all_objects,
    cleanup_old_objects,
    smart_cleanup,
    cleanup_candidates,
    delete_keys,
    client_for_bucket,
)


def create_app():
    app = Flask(__name__, static_folder="static", static_url_path="/static")

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

    @app.post("/api/buckets/<bucket>/cleanup")
    def cleanup(bucket):
        if not _ensure_allowed(bucket):
            return jsonify({"error": "Bucket not allowed"}), 400
        days = request.args.get("days", default=30, type=int)
        result = cleanup_old_objects(bucket, days=days)
        code = 200 if "error" not in result else 500
        return jsonify(result), code

    @app.get("/api/buckets/<bucket>/cleanup-preview")
    def cleanup_preview(bucket):
        if not _ensure_allowed(bucket):
            return jsonify({"error": "Bucket not allowed"}), 400
        days = request.args.get("days", default=30, type=int)
        prefix = request.args.get("prefix") or None
        try:
            result = cleanup_candidates(bucket=bucket, days=days, prefix=prefix)
            return jsonify(result)
        except Exception as e:
            return jsonify({"error": str(e)}), 500

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

    @app.get("/")
    def index():
        return send_from_directory(app.static_folder, "index.html")

    # SPA routes to enable shareable URLs for bucket/prefix
    @app.get("/b/<bucket>")
    def spa_bucket(bucket):
        return send_from_directory(app.static_folder, "index.html")

    @app.get("/b/<bucket>/p/<path:prefix>")
    def spa_prefix(bucket, prefix):
        return send_from_directory(app.static_folder, "index.html")

    @app.get("/api/buckets/<bucket>/download")
    def download_object(bucket):
        if not _ensure_allowed(bucket):
            return jsonify({"error": "Bucket not allowed"}), 400
        key = request.args.get("key")
        if not key:
            return jsonify({"error": "Missing key"}), 400
        disposition = request.args.get("disposition", default="attachment")
        try:
            s3 = client_for_bucket(bucket)
            filename = key.split("/")[-1] or "download"
            params = {
                "Bucket": bucket,
                "Key": key,
                "ResponseContentDisposition": f"{disposition}; filename=\"{filename}\"",
            }
            url = s3.generate_presigned_url("get_object", Params=params, ExpiresIn=300)
            return redirect(url, code=302)
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    return app


app = create_app()

if __name__ == "__main__":
    port = int(os.getenv("PORT", "8000"))
    app.run(host="0.0.0.0", port=port)
