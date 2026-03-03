"""
Rate limiter for AI generation endpoints.

Tracks usage per two keys simultaneously:
  • cookie:  a UUID stored in the "rl_id" browser cookie
  • ip:      the client's IP address (forwarded-for is respected)

Both keys share the same limit.  A request is rejected if *either* key
has already reached the cap, preventing trivial bypass by clearing cookies.

Defaults: 5 generations per 24-hour sliding window.
"""

from __future__ import annotations

import threading
import time
import uuid
from collections import defaultdict
from typing import Optional, Tuple

from fastapi import Cookie, HTTPException, Request, Response

# ── Tuneable constants ────────────────────────────────────────────────────────
RATE_LIMIT: int = 5           # max generations allowed
WINDOW_SECONDS: int = 86400   # 24 hours
COOKIE_NAME: str = "rl_id"
COOKIE_MAX_AGE: int = 365 * 24 * 3600  # 1 year


class RateLimiter:
    """Thread-safe, in-memory sliding-window rate limiter."""

    def __init__(self, limit: int = RATE_LIMIT, window: int = WINDOW_SECONDS):
        self.limit = limit
        self.window = window
        # key → sorted list of UTC timestamps (seconds)
        self._store: dict[str, list[float]] = defaultdict(list)
        self._lock = threading.Lock()

    # ── Internal helpers ──────────────────────────────────────────────────

    def _evict(self, key: str, now: float) -> None:
        """Remove timestamps outside the current window (call with lock held)."""
        cutoff = now - self.window
        self._store[key] = [t for t in self._store[key] if t >= cutoff]

    # ── Public API ────────────────────────────────────────────────────────

    def remaining(self, key: str) -> int:
        """How many requests the key has left in the current window."""
        now = time.time()
        with self._lock:
            self._evict(key, now)
            return max(0, self.limit - len(self._store[key]))

    def reset_in(self, key: str) -> int:
        """Seconds until the oldest timestamp expires (0 if window is empty)."""
        now = time.time()
        with self._lock:
            self._evict(key, now)
            if not self._store[key]:
                return 0
            return int(self.window - (now - min(self._store[key])))

    def check_and_record(self, key: str) -> Tuple[bool, int]:
        """
        Atomically check + record a new request.
        Returns (allowed: bool, remaining_after: int).
        Does NOT record if not allowed.
        """
        now = time.time()
        with self._lock:
            self._evict(key, now)
            count = len(self._store[key])
            if count >= self.limit:
                return False, 0
            self._store[key].append(now)
            return True, self.limit - count - 1


# ── Module-level singleton (shared across all requests) ───────────────────────
_limiter = RateLimiter()


# ── FastAPI helpers ───────────────────────────────────────────────────────────

def _get_client_ip(request: Request) -> str:
    """Extract the real client IP, honouring common proxy headers."""
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()
    real_ip = request.headers.get("X-Real-IP")
    if real_ip:
        return real_ip.strip()
    return request.client.host if request.client else "unknown"


async def enforce_rate_limit(
    request: Request,
    response: Response,
    rl_id: Optional[str] = Cookie(default=None),
) -> dict:
    """
    FastAPI dependency.  Raises HTTP 429 if either the cookie-based or
    IP-based counter has been exhausted.  Sets the rl_id cookie for new
    visitors and appends X-RateLimit-* headers to every response.
    """
    ip = _get_client_ip(request)

    # Assign a cookie ID to new visitors
    is_new_cookie = not rl_id
    if is_new_cookie:
        rl_id = str(uuid.uuid4())
        response.set_cookie(
            key=COOKIE_NAME,
            value=rl_id,
            max_age=COOKIE_MAX_AGE,
            httponly=True,
            samesite="lax",
        )

    cookie_key = f"cookie:{rl_id}"
    ip_key = f"ip:{ip}"

    # Pre-check remaining before recording
    cookie_left = _limiter.remaining(cookie_key)
    ip_left = _limiter.remaining(ip_key)

    if cookie_left == 0 or ip_left == 0:
        reset_secs = max(
            _limiter.reset_in(cookie_key),
            _limiter.reset_in(ip_key),
        )
        hrs, rem = divmod(reset_secs, 3600)
        mins = rem // 60
        raise HTTPException(
            status_code=429,
            detail={
                "error": "rate_limit_exceeded",
                "message": (
                    f"You have used all {RATE_LIMIT} free generations for today. "
                    f"Resets in {hrs}h {mins}m."
                ),
                "remaining": 0,
                "limit": RATE_LIMIT,
                "reset_in_seconds": reset_secs,
            },
            headers={"Retry-After": str(reset_secs)},
        )

    # Consume one unit from both keys
    _, cookie_after = _limiter.check_and_record(cookie_key)
    _, ip_after = _limiter.check_and_record(ip_key)
    remaining_after = min(cookie_after, ip_after)

    response.headers["X-RateLimit-Limit"] = str(RATE_LIMIT)
    response.headers["X-RateLimit-Remaining"] = str(remaining_after)
    response.headers["X-RateLimit-Window"] = "86400"

    return {"remaining": remaining_after, "cookie_id": rl_id, "ip": ip}


def get_status(
    request: Request,
    response: Response,
    rl_id: Optional[str] = Cookie(default=None),
) -> dict:
    """
    Read-only status check (used by the /api/rate-limit-status endpoint).
    Does NOT consume a generation.
    """
    ip = _get_client_ip(request)

    is_new_cookie = not rl_id
    if is_new_cookie:
        rl_id = str(uuid.uuid4())
        response.set_cookie(
            key=COOKIE_NAME,
            value=rl_id,
            max_age=COOKIE_MAX_AGE,
            httponly=True,
            samesite="lax",
        )

    cookie_key = f"cookie:{rl_id}"
    ip_key = f"ip:{ip}"

    cookie_left = _limiter.remaining(cookie_key)
    ip_left = _limiter.remaining(ip_key)
    remaining = min(cookie_left, ip_left)

    reset_secs = max(
        _limiter.reset_in(cookie_key),
        _limiter.reset_in(ip_key),
    ) if remaining < RATE_LIMIT else 0

    return {
        "remaining": remaining,
        "limit": RATE_LIMIT,
        "window_seconds": WINDOW_SECONDS,
        "reset_in_seconds": reset_secs,
    }
