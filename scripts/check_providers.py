#!/usr/bin/env python3
"""
Live provider health check through the router's OpenAI-compatible API.

Uses the official `openai` Python library against the deployed worker and
forces each provider with the router's `model@provider` syntax (safe for
slashed ids like `@cf/meta/...`). Sample models are picked ONLY from the
router's own GET /v1/models catalog — providers missing from that list are
skipped (not configured), and free models (`*free*`) are preferred so errors
stay minimal. Providers registering vision-capable models get a second,
multimodal request using an image from sample_image/.

Requires:  pip install openai

Usage:
    python scripts/check_providers.py [--base-url URL] [--api-key KEY]
                                      [--image PATH] [--only id1,id2]
                                      [--skip-vision] [--max-tokens N]

Credentials resolve in order: --api-key flag > ROUTER_API_KEY env >
ROUTER_API_KEY from .dev.vars. Base URL resolves: --base-url >
ROUTER_BASE_URL env > the production worker.

Verdicts:
    OK      200 (provider works)
    LIMITED rate-limited/cooldown right now — shows when it will work again
    QUOTA   upstream 429 passed through (works, quota exhausted)
    SKIP    provider not in /v1/models (not configured)
    FAIL    anything else (auth, config, upstream error)
Exit code is non-zero when any FAIL occurred (LIMITED/SKIP don't fail).
"""

from __future__ import annotations

import argparse
import base64
import io
import mimetypes
import os
import sys
import time
from collections import defaultdict
from pathlib import Path

try:
    import openai
    from openai import OpenAI
except ImportError:
    sys.exit("openai package missing — run: pip install openai")

# cp1252 Windows consoles cannot encode ✅/⚠️/❌ verdict glyphs.
for _stream in (sys.stdout, sys.stderr):
    if isinstance(_stream, io.TextIOWrapper):
        _stream.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_BASE_URL = "https://free-llm-router.vipulgote5.workers.dev/v1"

TEXT_PROMPT = "Reply with exactly: pong"
VISION_PROMPT = "What company logo or name appears in this image? One short sentence."

CHEAP_HINTS = ("flash", "lite", "mini", "nano", "instant", "small", "haiku")


def load_dev_vars() -> dict[str, str]:
    path = ROOT / ".dev.vars"
    out: dict[str, str] = {}
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            out[key.strip()] = value.strip()
    except OSError:
        pass
    return out


def fetch_catalog(client: OpenAI) -> dict[str, list[tuple[str, list[str]]]]:
    """GET /v1/models → provider -> [(model_id, capabilities)]."""
    by_provider: dict[str, list[tuple[str, list[str]]]] = defaultdict(list)
    for m in client.models.list().data:
        extra = getattr(m, "model_extra", {}) or {}
        caps = extra.get("capabilities") or []
        by_provider[m.owned_by].append((m.id, list(caps)))
    return dict(by_provider)


def ranked_samples(models: list[tuple[str, list[str]]], want_vision: bool) -> list[str]:
    """Capability-matching model ids, cheapest/free-looking first."""
    scored: list[tuple[int, int, str]] = []
    for idx, (mid, caps) in enumerate(models):
        if want_vision and "vision" not in caps:
            continue
        if not want_vision and ("embeddings" in caps or "vision" in caps):
            continue
        low = mid.lower()
        score = sum(4 for h in CHEAP_HINTS if h in low)
        if "free" in low:
            score += 100
        scored.append((-score, idx, mid))
    return [mid for _, _, mid in sorted(scored)]


def pick_image(explicit: str | None) -> Path | None:
    if explicit:
        p = Path(explicit)
        if not p.is_file():
            sys.exit(f"image not found: {p}")
        return p
    sample_dir = ROOT / "sample_image"
    if not sample_dir.is_dir():
        return None
    for ext in ("*.jpg", "*.jpeg", "*.png"):
        files = sorted(sample_dir.glob(ext))
        if files:
            return files[0]
    return None


def to_data_uri(path: Path) -> str:
    mime = mimetypes.guess_type(path.name)[0] or "image/jpeg"
    b64 = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime};base64,{b64}"


def fmt_eta(seconds: int) -> str:
    if seconds < 90:
        return f"{seconds}s"
    if seconds < 5400:
        return f"{seconds // 60}m {seconds % 60}s"
    if seconds < 172800:
        return f"{seconds // 3600}h {(seconds % 3600) // 60}m"
    return f"{seconds // 86400}d {(seconds % 86400) // 3600}h"


def classify(exc: Exception) -> tuple[str, str, int]:
    """(verdict, detail, eta_seconds — nonzero only for LIMITED)."""
    if isinstance(exc, openai.RateLimitError):
        return "QUOTA", f"429 {exc.message[:80]}", 0
    if isinstance(exc, openai.AuthenticationError):
        return "FAIL", f"401/403 auth: {exc.message[:80]}", 0
    if isinstance(exc, openai.NotFoundError):
        return "FAIL", f"404 unknown model/provider: {exc.message[:80]}", 0
    if isinstance(exc, openai.APIStatusError):
        body = exc.body if isinstance(exc.body, dict) else {}
        err = body if "code" in body or "tried" in body else body.get("error", {})
        tried = err.get("tried") or []
        if err.get("code") == "all_providers_exhausted" and tried:
            secs = [t.get("retryAfterSec") for t in tried if t.get("retryAfterSec")]
            reasons = sorted({str(t.get("reason")) for t in tried})
            if secs and set(reasons) <= {"cooldown", "limit"}:
                eta = max(secs)
                when = time.strftime("%H:%M", time.localtime(time.time() + eta))
                return "LIMITED", (
                    f"{'+'.join(reasons)} · works again in "
                    f"{fmt_eta(eta)} (~{when}, {time.strftime('%Z')})"
                ), eta
            detail = "; ".join(
                f"{t.get('provider')}:{t.get('bucket')}={t.get('reason')}" for t in tried
            )
            return "FAIL", f"503 exhausted [{detail[:110]}]", 0
        msg = (err.get("message") or exc.message or "").replace("\n", " ")
        return "FAIL", f"{exc.status_code} {msg[:110]}", 0
    if isinstance(exc, openai.APITimeoutError):
        return "FAIL", "request timed out", 0
    if isinstance(exc, openai.APIConnectionError):
        return "FAIL", f"connection error: {exc}", 0
    return "FAIL", f"{type(exc).__name__}: {exc}", 0


def run_case(client: OpenAI, model_spec: str, messages: list, max_tokens: int) -> dict:
    t0 = time.monotonic()
    try:
        raw = client.chat.completions.with_raw_response.create(
            model=model_spec,
            messages=messages,
            max_tokens=max_tokens,
            temperature=0,
        )
        ms = int((time.monotonic() - t0) * 1000)
        completion = raw.parse()
        served_by = raw.headers.get("x-router-provider", "?")
        served_model = raw.headers.get("x-router-model", "?")
        text = ""
        if completion.choices and completion.choices[0].message.content:
            text = completion.choices[0].message.content.replace("\n", " ").strip()
        return {
            "verdict": "OK", "ms": ms, "served_by": served_by,
            "served_model": served_model, "detail": text[:60],
        }
    except Exception as exc:  # noqa: BLE001 — every failure mode is a verdict
        ms = int((time.monotonic() - t0) * 1000)
        verdict, detail, eta = classify(exc)
        return {"verdict": verdict, "ms": ms, "served_by": "-", "served_model": "-",
                "detail": detail, "eta": eta}


def main() -> int:
    dev_vars = load_dev_vars()
    ap = argparse.ArgumentParser(description="Provider health check via the router")
    ap.add_argument("--base-url", default=os.environ.get("ROUTER_BASE_URL", DEFAULT_BASE_URL))
    ap.add_argument("--api-key",
                    default=os.environ.get("ROUTER_API_KEY") or dev_vars.get("ROUTER_API_KEY"))
    ap.add_argument("--image", default=None, help="path to test image (default: first in sample_image/)")
    ap.add_argument("--only", default=None, help="comma-separated provider ids to test")
    ap.add_argument("--skip-vision", action="store_true")
    ap.add_argument("--max-tokens", type=int, default=24)
    args = ap.parse_args()

    if not args.api_key:
        sys.exit("no API key — pass --api-key, set ROUTER_API_KEY, or add it to .dev.vars")

    client = OpenAI(base_url=args.base_url, api_key=args.api_key,
                    timeout=120.0, max_retries=0)

    try:
        catalog = fetch_catalog(client)
    except openai.APIStatusError as e:
        sys.exit(f"/v1/models failed: HTTP {e.status_code} — check the API key")

    only = {s.strip() for s in args.only.split(",")} if args.only else None
    image_path = None if args.skip_vision else pick_image(args.image)
    image_uri = to_data_uri(image_path) if image_path else None
    print(f"router : {args.base_url}")
    print(f"key    : {args.api_key[:8]}...{args.api_key[-4:]}")
    print(f"models : {sum(len(v) for v in catalog.values())} across {len(catalog)} providers")
    print(f"image  : {image_path if image_path else '(none — vision skipped)'}\n")

    results: list[tuple[str, str, str, dict]] = []
    for pid in sorted(catalog):
        if only and pid not in only:
            continue
        models = catalog[pid]
        cases: list[tuple[str, list[str]]] = []
        text_ranked = ranked_samples(models, want_vision=False)
        if text_ranked:
            cases.append(("text", text_ranked[:2]))
        if image_uri:
            vision_ranked = ranked_samples(models, want_vision=True)
            if vision_ranked:
                cases.append(("vision", vision_ranked[:2]))
        if not cases:
            print(f"⏭️  SKIP   {pid:<11} no eligible model in /v1/models")
            results.append((pid, "text", "-", {"verdict": "SKIP", "ms": 0}))
            continue

        for kind, candidates in cases:
            messages: list
            if kind == "text":
                messages = [{"role": "user", "content": TEXT_PROMPT}]
            else:
                messages = [{"role": "user", "content": [
                    {"type": "text", "text": VISION_PROMPT},
                    {"type": "image_url", "image_url": {"url": image_uri}},
                ]}]
            # try best candidate; on a hard FAIL (not quota/cooldown) fall
            # through to the next-ranked model; wait out self-inflicted
            # short cooldowns (<=90s) instead of reporting them as LIMITED
            r: dict | None = None
            spec = ""
            attempt_i = 0
            while attempt_i < len(candidates):
                model = candidates[attempt_i]
                spec = f"{model}@{pid}"
                r = run_case(client, spec, messages, args.max_tokens)
                if r["verdict"] == "LIMITED" and 0 < r.get("eta", 0) <= 90:
                    print(f"     ⏱ waiting {r['eta'] + 2}s out for {model} cooldown…")
                    time.sleep(r["eta"] + 2)
                    continue
                if r["verdict"] != "FAIL" or attempt_i == len(candidates) - 1:
                    break
                attempt_i += 1
                print(f"     ↻ {model} failed ({r['detail'][:60]}) — trying {candidates[attempt_i]}")
            assert r is not None
            results.append((pid, kind, spec, r))
            mark = {"OK": "✅", "LIMITED": "⏳", "QUOTA": "⚠️ ", "SKIP": "⏭️ ",
                    "FAIL": "❌"}[r["verdict"]]
            route = "" if r["served_by"] == "-" else f" via {r['served_by']}/{r['served_model']}"
            print(f"{mark} {r['verdict']:<7} {pid:<11} {kind:<6} "
                  f"{r['ms']:>6}ms  {spec.rsplit('@', 1)[0]}{route}")
            if r["verdict"] != "OK":
                print(f"     └─ {r['detail']}")

    ok = sum(1 for *_, r in results if r["verdict"] == "OK")
    limited = sum(1 for *_, r in results if r["verdict"] == "LIMITED")
    quota = sum(1 for *_, r in results if r["verdict"] == "QUOTA")
    skipped = sum(1 for *_, r in results if r["verdict"] == "SKIP")
    fail = len(results) - ok - limited - quota - skipped
    print(f"\nsummary: {ok} ok · {limited} rate-limited(will recover) · "
          f"{quota} quota-exhausted · {skipped} not-configured · {fail} failed "
          f"(of {len(results)} checks)")
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
