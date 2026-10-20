"""
main.py - FastAPI Application for Quotex Autonomous Paper-Trading & Self-Optimizing Agent.
Exposes REST APIs for screen frame analysis, virtual paper-trading execution,
automated trade verification, live session monitoring, and settings management.
"""

import os
import time
import json
import asyncio
import logging
from typing import Optional, Dict, Any, List
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from dotenv import load_dotenv

# Load environment variables from .env if present
load_dotenv()

from agent import (
    trading_session,
    vision_engine,
    auto_clicker,
    strategy_learner,
    VisionProcessor,
    STRICTNESS_TIERS,
    SessionStats,
    TradeRecord
)

logger = logging.getLogger("QuotexAPI")

# ==============================================================================
# TAMPERMONKEY INSTANT WEBSOCKET SIGNAL BROADCASTER (0ms DOM CLICK)
# ==============================================================================

class SignalBroadcaster:
    """Manages real-time WebSocket connections and broadcasts instant trade signals to Tampermonkey userscripts."""
    def __init__(self):
        self.active_connections: List[WebSocket] = []
        self.http_heartbeats: Dict[str, float] = {}
        self.latest_signal: Optional[Dict[str, Any]] = None

    def record_heartbeat(self, client_id: str):
        self.http_heartbeats[client_id] = time.time()

    def get_active_client_count(self) -> int:
        now = time.time()
        # Keep clients active if seen within the last 15 seconds
        self.http_heartbeats = {cid: t for cid, t in self.http_heartbeats.items() if now - t < 15.0}
        return len(self.active_connections) + len(self.http_heartbeats)

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        logger.info(f"⚡ [TAMPERMONKEY CONNECTED] Quotex Userscript connected via WebSocket. Active tabs: {self.get_active_client_count()}")
        try:
            await websocket.send_json({
                "type": "CONNECTION_ESTABLISHED",
                "message": "Connected to Quotex Autonomous Agent Backend (0ms DOM execution active)",
                "timestamp": int(time.time() * 1000)
            })
        except Exception:
            pass

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
            logger.info(f"Tampermonkey client disconnected. Remaining tabs: {self.get_active_client_count()}")

    async def broadcast_signal(self, signal: Dict[str, Any]):
        self.latest_signal = signal
        active_count = self.get_active_client_count()
        if active_count == 0:
            logger.info("No active Tampermonkey userscripts connected. Fallback to hardware mouse clicking if enabled.")
            return

        logger.info(f"⚡ [INSTANT DOM DISPATCH] Broadcasting {signal.get('direction')} to {active_count} Tampermonkey tab(s) (0ms zero-movement)!")
        disconnected = []
        for ws in list(self.active_connections):
            try:
                await ws.send_json(signal)
            except Exception as e:
                logger.warning(f"Failed to send to Tampermonkey client: {e}")
                disconnected.append(ws)
        for ws in disconnected:
            self.disconnect(ws)

signal_broadcaster = SignalBroadcaster()

app = FastAPI(
    title="Quotex Autonomous Paper-Trading Agent API",
    description="Vision AI & Self-Optimizing Quantitative Agent for Quotex Demo Charts",
    version="1.0.0"
)

# Enable CORS for local development and browser extensions
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Ensure static directory exists
STATIC_DIR = Path(__file__).parent / "static"
STATIC_DIR.mkdir(parents=True, exist_ok=True)

# Mount static files
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


# ==============================================================================
# REQUEST & RESPONSE SCHEMAS
# ==============================================================================

class AnalyzeRequest(BaseModel):
    image_base64: str = Field(..., description="Base64 encoded frame captured from browser")
    timeframe_seconds: int = Field(default=60, ge=5, le=3600, description="Candle timeframe in seconds")
    crop_bounds: Optional[Dict[str, float]] = Field(default=None, description="Custom crop fractions: top, bottom, left, right")
    auto_execute: bool = Field(default=True, description="Whether to execute paper trade automatically on CALL/PUT")


class VerifyRequest(BaseModel):
    trade_id: Optional[str] = Field(default=None, description="Trade ID to verify")
    image_base64: Optional[str] = Field(default=None, description="Base64 frame at candle expiry")
    manual_close_price: Optional[float] = Field(default=None, description="Explicit manual close price if desired")


class AutoCycleRequest(BaseModel):
    image_base64: str = Field(..., description="Base64 frame captured from browser")
    timeframe_seconds: int = Field(default=60)
    crop_bounds: Optional[Dict[str, float]] = None
    force_verify: bool = Field(default=False, description="Force verification of active trade regardless of timer")
    execute_trade: bool = Field(default=True, description="Whether to open paper/live trade if CALL/PUT signal detected")


class ConfigUpdateRequest(BaseModel):
    api_key: Optional[str] = None
    base_url: Optional[str] = None
    model_name: Optional[str] = None
    trade_amount: Optional[float] = Field(default=None, ge=1.0)
    payout_rate: Optional[float] = Field(default=None, ge=0.1, le=1.0)
    strictness_level: Optional[int] = Field(default=None, ge=1, le=5)
    auto_optimize: Optional[bool] = None


class TradeOverrideRequest(BaseModel):
    trade_id: Optional[str] = Field(default=None, description="Trade ID to override (or empty for active/latest)")
    outcome: str = Field(..., description="Target outcome: 'LOSS' or 'WIN'")



# ==============================================================================
# ROUTES
# ==============================================================================

@app.get("/", include_in_schema=False)
async def root():
    """Serves the main dashboard application."""
    index_file = STATIC_DIR / "index.html"
    if index_file.exists():
        return FileResponse(str(index_file))
    return RedirectResponse(url="/static/index.html")


@app.get("/api/status", response_model=SessionStats)
async def get_session_status():
    """Returns current live session metrics, rolling accuracy, and active trade."""
    return trading_session.get_stats()


@app.get("/api/trades", response_model=List[TradeRecord])
async def get_trade_history():
    """Returns all recorded trades in the current session."""
    with trading_session.lock:
        return list(trading_session.trade_history)


@app.post("/api/trades/override")
async def override_trade_outcome(payload: TradeOverrideRequest):
    """
    User Ground-Truth Outcome Correction:
    Allows user to immediately mark any trade as REAL LOSS (0.00 $) or REAL WIN.
    Reverses inaccurate balance/PnL, updates win rate, and trains the strategy learner.
    """
    try:
        updated = trading_session.override_trade_outcome(
            trade_id=payload.trade_id or "",
            new_outcome=payload.outcome.upper()
        )
        if not updated:
            raise HTTPException(status_code=404, detail="No matching trade found to override.")
        return {
            "success": True,
            "message": f"Trade outcome corrected to {payload.outcome.upper()}.",
            "trade": updated.model_dump(),
            "session": trading_session.get_stats().model_dump()
        }
    except Exception as e:
        logger.exception("Error during trade outcome override")
        raise HTTPException(status_code=500, detail=str(e))



@app.post("/api/analyze-and-trade")
async def analyze_and_trade(payload: AnalyzeRequest):
    """
    Core Vision Ingestion & Decision Endpoint:
      1. Crops the Quotex chart frame.
      2. Runs Vision AI / Heuristic analysis.
      3. If decision is CALL/PUT and auto_execute is True, opens a virtual trade.
    """
    try:
        # 1. Ingest and Crop Chart Frame
        raw_pil = VisionProcessor.decode_base64_image(payload.image_base64)
        cropped_pil = VisionProcessor.auto_crop_quotex_chart(raw_pil, payload.crop_bounds)
        cropped_b64 = VisionProcessor.encode_image_base64(cropped_pil, format="JPEG", quality=85)

        # 2. Run Vision AI / Strategy Analysis
        decision_data = vision_engine.analyze_chart(
            image_b64=cropped_b64,
            strictness_level=trading_session.current_strictness,
            candle_timeframe=payload.timeframe_seconds
        )

        direction = decision_data["direction"]
        confidence = decision_data["confidence"]
        entry_price = decision_data["current_price"]
        trend = decision_data["trend"]
        setup_grade = decision_data["setup_grade"]
        reasoning = decision_data["reasoning"]

        trade_opened = None

        # 3. Virtual Paper Execution (T=0)
        if direction in ["CALL", "PUT"] and payload.auto_execute:
            with trading_session.lock:
                active_trade = trading_session.active_trade

            if active_trade is not None:
                # Active trade in flight, do not open another until expired
                logger.info("Trade signal generated but an active paper trade is already in progress.")
            else:
                trade_opened = trading_session.open_trade(
                    direction=direction,
                    entry_price=entry_price,
                    confidence=confidence,
                    rationale=reasoning,
                    trend=trend,
                    setup_grade=setup_grade,
                    pattern_name=decision_data.get("pattern_name", "Standard"),
                    timeframe_seconds=payload.timeframe_seconds,
                    indicators_summary={
                        "rejection_wick_found": decision_data.get("rejection_wick_found", False),
                        "key_level": decision_data.get("support_resistance_level", ""),
                        "pos_ratio": decision_data.get("pos_ratio", 0.5),
                        "streak": decision_data.get("streak", 0),
                        "opposing_wick_ratio": decision_data.get("opposing_wick_ratio", 0.0),
                        "body_ratio": decision_data.get("body_ratio", 0.5),
                        "candle_color": decision_data.get("candle_color", "GREEN" if direction == "CALL" else "RED")
                    }
                )
                # Instant broadcast to Tampermonkey userscript inside Quotex (0ms DOM click, zero mouse movement)
                signal_data = {
                    "type": "TRADE_SIGNAL",
                    "action": "EXECUTE",
                    "direction": direction,
                    "confidence": confidence,
                    "probability": confidence,
                    "candle_probability": decision_data.get("candle_probability", confidence),
                    "trade_id": trade_opened.id if trade_opened else str(int(time.time())),
                    "timestamp": int(time.time() * 1000),
                    "timeframe": payload.timeframe_seconds,
                    "pattern_name": decision_data.get("pattern_name", "UNKNOWN"),
                    "candle_color": decision_data.get("candle_color", "GREEN" if direction == "CALL" else "RED"),
                    "source": "AI_AGENT"
                }
                await signal_broadcaster.broadcast_signal(signal_data)

                # Fallback to physical mouse clicking ONLY if no Tampermonkey tab is active and auto_clicker is enabled
                if signal_broadcaster.get_active_client_count() == 0 and auto_clicker.config.enabled:
                    auto_clicker.execute_click(direction)

        return {
            "success": True,
            "decision": decision_data,
            "trade_opened": trade_opened.model_dump() if trade_opened else None,
            "cropped_preview_b64": cropped_b64,
            "session": trading_session.get_stats().model_dump()
        }

    except Exception as e:
        logger.exception("Error during analyze_and_trade execution")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/verify-trade")
async def verify_trade(payload: VerifyRequest):
    """
    Outcome Verification Endpoint (T+Expiry):
      1. Determines closing price from the verification frame or input.
      2. Resolves trade as WIN, LOSS, or DRAW.
      3. Updates rolling accuracy and triggers strategy self-optimization.
    """
    try:
        active = trading_session.active_trade
        if not active:
            raise HTTPException(status_code=400, detail="No active paper trade to verify.")

        close_price = payload.manual_close_price
        if close_price is None:
            if not payload.image_base64:
                raise HTTPException(status_code=400, detail="Either manual_close_price or image_base64 must be provided.")
            
            # Extract close price from verification image
            raw_pil = VisionProcessor.decode_base64_image(payload.image_base64)
            cropped_pil = VisionProcessor.auto_crop_quotex_chart(raw_pil)
            cropped_b64 = VisionProcessor.encode_image_base64(cropped_pil)

            close_price = vision_engine.verify_price_from_frame(
                image_b64=cropped_b64,
                entry_price=active.entry_price,
                direction=active.direction,
                raw_image_b64=payload.image_base64
            )

        resolved_trade = trading_session.resolve_trade(
            close_price=close_price,
            trade_id=payload.trade_id or active.id
        )

        return {
            "success": True,
            "trade": resolved_trade.model_dump(),
            "session": trading_session.get_stats().model_dump()
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error during verify_trade execution")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/auto-cycle")
async def auto_cycle(payload: AutoCycleRequest):
    """
    Automated Continuous Cycle Endpoint:
      - Checks if active trade is expired: if so, verifies it using current frame.
      - If no active trade: executes analysis and opens trade if high conviction.
    """
    try:
        active = trading_session.active_trade
        now = time.time()

        resolved_trade = None
        # Step 1: Check if pending trade needs verification (with 3-second grace window for candle boundary sync)
        if active and (now >= (active.expiry_timestamp - 3.0) or payload.force_verify):
            # Verify pending trade
            raw_pil = VisionProcessor.decode_base64_image(payload.image_base64)
            cropped_pil = VisionProcessor.auto_crop_quotex_chart(raw_pil, payload.crop_bounds)
            cropped_b64 = VisionProcessor.encode_image_base64(cropped_pil)

            close_price = vision_engine.verify_price_from_frame(
                image_b64=cropped_b64,
                entry_price=active.entry_price,
                direction=active.direction,
                raw_image_b64=payload.image_base64
            )
            resolved_trade = trading_session.resolve_trade(close_price=close_price, trade_id=active.id)
            active = None  # Trade resolved; ready to scan for next setup

            # Post-Trade Safety Shield: Do NOT open an immediate trade on the stale verification frame.
            # Return resolution immediately so UI updates stats, plays audio, and awaits next fresh live candle.
            return {
                "cycle_action": f"TRADE_RESOLVED_{resolved_trade.outcome}",
                "resolved_trade": resolved_trade.model_dump(),
                "session": trading_session.get_stats().model_dump()
            }

        # Step 2: If a trade is still in progress (not expired), wait
        if active and now < active.expiry_timestamp:
            remaining = int(active.expiry_timestamp - now)
            return {
                "cycle_action": "TRADE_IN_PROGRESS",
                "remaining_seconds": remaining,
                "active_trade": active.model_dump(),
                "session": trading_session.get_stats().model_dump()
            }

        # Step 3: No active trade (either none open or just resolved) -> Ingest and analyze frame
        raw_pil = VisionProcessor.decode_base64_image(payload.image_base64)
        cropped_pil = VisionProcessor.auto_crop_quotex_chart(raw_pil, payload.crop_bounds)
        cropped_b64 = VisionProcessor.encode_image_base64(cropped_pil)

        decision = vision_engine.analyze_chart(
            image_b64=cropped_b64,
            strictness_level=trading_session.current_strictness,
            candle_timeframe=payload.timeframe_seconds
        )

        direction = decision["direction"]
        confidence = float(decision.get("confidence", 0.0))
        opened_trade = None

        if direction in ["CALL", "PUT"] and payload.execute_trade:
            opened_trade = trading_session.open_trade(
                direction=direction,
                entry_price=decision["current_price"],
                confidence=confidence,
                rationale=decision["reasoning"],
                trend=decision["trend"],
                setup_grade=decision["setup_grade"],
                pattern_name=decision.get("pattern_name", "Standard"),
                timeframe_seconds=payload.timeframe_seconds,
                indicators_summary={
                    "rejection_wick_found": decision.get("rejection_wick_found", False),
                    "key_level": decision.get("support_resistance_level", ""),
                    "pos_ratio": decision.get("pos_ratio", 0.5),
                    "streak": decision.get("streak", 0),
                    "opposing_wick_ratio": decision.get("opposing_wick_ratio", 0.0),
                    "body_ratio": decision.get("body_ratio", 0.5),
                    "candle_color": decision.get("candle_color", "GREEN" if direction == "CALL" else "RED")
                }
            )
            action = f"TRADE_OPENED_{direction}"
            # Instant broadcast to Tampermonkey userscript inside Quotex (0ms DOM click, zero mouse movement)
            signal_data = {
                "type": "TRADE_SIGNAL",
                "action": "EXECUTE",
                "direction": direction,
                "confidence": confidence,
                "probability": confidence,
                "candle_probability": decision.get("candle_probability", confidence),
                "trade_id": opened_trade.id if opened_trade else str(int(time.time())),
                "timestamp": int(time.time() * 1000),
                "timeframe": payload.timeframe_seconds,
                "pattern_name": decision.get("pattern_name", "UNKNOWN"),
                "candle_color": decision.get("candle_color", "GREEN" if direction == "CALL" else "RED"),
                "source": "AI_AGENT"
            }
            await signal_broadcaster.broadcast_signal(signal_data)

            # Fallback to physical mouse clicking ONLY if no Tampermonkey tab is active and auto_clicker is enabled
            if signal_broadcaster.get_active_client_count() == 0 and auto_clicker.config.enabled:
                auto_clicker.execute_click(direction)
        elif direction in ["CALL", "PUT"] and not payload.execute_trade:
            action = f"SIGNAL_ACTIVE_{direction}_PREVIEW"
        else:
            action = "SKIPPED_FILTERED"

        if resolved_trade:
            action = f"TRADE_RESOLVED_{resolved_trade.outcome}" + (f"_AND_OPENED_{direction}" if opened_trade else "")

        return {
            "cycle_action": action,
            "decision": decision,
            "trade": opened_trade.model_dump() if opened_trade else (resolved_trade.model_dump() if resolved_trade else None),
            "resolved_trade": resolved_trade.model_dump() if resolved_trade else None,
            "cropped_preview_b64": cropped_b64,
            "session": trading_session.get_stats().model_dump()
        }

    except Exception as e:
        logger.exception("Error during auto_cycle execution")
        raise HTTPException(status_code=500, detail=str(e))


# ==============================================================================
# DIRECT QUOTEX AUTO-CLICKER ENDPOINTS
# ==============================================================================

class AutoClickUpdateRequest(BaseModel):
    enabled: Optional[bool] = None
    call_x: Optional[int] = None
    call_y: Optional[int] = None
    put_x: Optional[int] = None
    put_y: Optional[int] = None
    restore_cursor: Optional[bool] = None


class TestClickRequest(BaseModel):
    direction: str = Field(..., description="CALL or PUT")


@app.post("/api/quotex/feed")
async def quotex_feed(request: Request):
    """
    Receives live price feed/quotes from browser extension or userscripts.
    Silences 404 logs and captures any incoming quotes safely.
    """
    try:
        data = await request.json()
        return {"status": "ok", "received": True}
    except Exception:
        return {"status": "ok", "received": False}


@app.get("/api/autoclick/config")
async def get_autoclick_config():
    """Returns current auto-clicker status and target coordinates."""
    return auto_clicker.config.model_dump()


@app.post("/api/autoclick/config")
async def update_autoclick_config(payload: AutoClickUpdateRequest):
    """Updates auto-clicker coordinates and enable/disable state."""
    auto_clicker.update_config(
        enabled=payload.enabled,
        call_x=payload.call_x,
        call_y=payload.call_y,
        put_x=payload.put_x,
        put_y=payload.put_y,
        restore_cursor=payload.restore_cursor
    )
    return {"success": True, "config": auto_clicker.config.model_dump()}


@app.get("/api/autoclick/mouse-pos")
async def get_mouse_position():
    """Returns live screen coordinates of the user's cursor for calibration."""
    return auto_clicker.get_mouse_position()


@app.post("/api/autoclick/test-click")
async def test_autoclick(payload: TestClickRequest):
    """Performs an immediate single test click on the target button."""
    return auto_clicker.test_click(payload.direction.upper())


@app.post("/api/autoclick/auto-detect")
async def auto_detect_buttons():
    """Automatically scans visible screen to find Quotex Green Buy and Red Sell buttons."""
    return auto_clicker.auto_detect_quotex_buttons()



@app.post("/api/reset")
async def reset_session():
    """Resets paper trading balance, ledger history, and rolling accuracy."""
    trading_session.reset_session()
    return {"success": True, "message": "Session reset successfully", "session": trading_session.get_stats().model_dump()}


@app.get("/api/config")
async def get_config():
    """Returns runtime AI and strategy configuration."""
    api_key_masked = "Not Set (Using Heuristic CV)"
    if vision_engine.api_key:
        api_key_masked = f"{vision_engine.api_key[:4]}...{vision_engine.api_key[-4:]}"

    return {
        "api_key_configured": bool(vision_engine.api_key),
        "api_key_masked": api_key_masked,
        "base_url": vision_engine.base_url,
        "model_name": vision_engine.model_name,
        "trade_amount": trading_session.trade_amount,
        "payout_rate": trading_session.payout_rate,
        "current_strictness": trading_session.current_strictness,
        "auto_optimize": trading_session.auto_optimize,
        "strictness_tiers": {k: v.model_dump() for k, v in STRICTNESS_TIERS.items()}
    }


@app.post("/api/config")
async def update_config(payload: ConfigUpdateRequest):
    """Updates runtime AI engine and trading parameters."""
    if payload.api_key is not None or payload.base_url is not None or payload.model_name is not None:
        vision_engine.update_config(
            api_key=payload.api_key,
            base_url=payload.base_url,
            model_name=payload.model_name
        )

    with trading_session.lock:
        if payload.trade_amount is not None:
            trading_session.trade_amount = payload.trade_amount
        if payload.payout_rate is not None:
            trading_session.payout_rate = payload.payout_rate
        if payload.strictness_level is not None:
            trading_session.current_strictness = payload.strictness_level
        if payload.auto_optimize is not None:
            trading_session.auto_optimize = payload.auto_optimize

    return {"success": True, "message": "Configuration updated successfully."}


@app.get("/api/learning")
async def get_strategy_learning():
    """Returns self-adaptive AI pattern memory, win rates, and blocked/boosted setups."""
    return strategy_learner.get_learning_summary()


# ==============================================================================
# TAMPERMONKEY 5.5.1 INSTANT DOM TRADING WEBSOCKET & API ENDPOINTS
# ==============================================================================

@app.websocket("/ws/trade-signals")
async def websocket_trade_signals(websocket: WebSocket):
    """
    Ultra-low-latency (< 1ms) persistent WebSocket connection for Tampermonkey userscripts.
    Dispatches instant trade signals directly to Quotex browser tabs with ZERO physical mouse movement.
    """
    await signal_broadcaster.connect(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            try:
                msg = json.loads(data)
                if msg.get("type") == "PING":
                    await websocket.send_json({"type": "PONG", "timestamp": int(time.time() * 1000)})
                elif msg.get("type") == "TRADE_EXECUTED_ACK":
                    logger.info(f"⚡ [TAMPERMONKEY ACK] {msg.get('direction')} clicked inside Quotex DOM in {msg.get('latency_ms', 0)}ms!")
            except Exception:
                pass
    except WebSocketDisconnect:
        signal_broadcaster.disconnect(websocket)
    except Exception as e:
        logger.warning(f"WebSocket client error: {e}")
        signal_broadcaster.disconnect(websocket)


@app.get("/api/signals/latest")
async def get_latest_signal(client_id: Optional[str] = None):
    """Returns the most recent trade signal for Tampermonkey HTTP polling fallback."""
    if client_id:
        signal_broadcaster.record_heartbeat(client_id)
    return {
        "success": True,
        "signal": signal_broadcaster.latest_signal,
        "connected_clients": signal_broadcaster.get_active_client_count()
    }


@app.get("/api/signals/status")
async def get_signals_status():
    """Returns status of connected Tampermonkey userscript clients."""
    return {
        "connected_tampermonkey_clients": signal_broadcaster.get_active_client_count(),
        "latest_signal": signal_broadcaster.latest_signal
    }


@app.post("/api/signals/test")
async def test_broadcast_signal(payload: Dict[str, Any]):
    """Sends a manual test signal to connected Tampermonkey userscript."""
    direction = str(payload.get("direction", "CALL")).upper()
    confidence = float(payload.get("confidence", 92.5))
    signal = {
        "type": "TRADE_SIGNAL",
        "action": "EXECUTE",
        "direction": direction,
        "confidence": confidence,
        "probability": confidence,
        "candle_probability": confidence,
        "trade_id": f"test_{int(time.time())}",
        "timestamp": int(time.time() * 1000),
        "timeframe": 60,
        "pattern_name": "Bullish Continuation" if direction == "CALL" else "Bearish Rejection",
        "candle_color": "GREEN" if direction == "CALL" else "RED",
        "source": "MANUAL_TEST"
    }
    await signal_broadcaster.broadcast_signal(signal)
    return {
        "success": True,
        "broadcasted_to": signal_broadcaster.get_active_client_count(),
        "signal": signal
    }


@app.get("/quotex-instant-executor.user.js", include_in_schema=False)
async def serve_userscript():
    """Serves the Tampermonkey userscript directly for 1-click browser installation."""
    script_path = Path(__file__).parent / "quotex-instant-executor.user.js"
    if not script_path.exists():
        script_path = STATIC_DIR / "quotex-instant-executor.user.js"
    return FileResponse(
        str(script_path),
        media_type="application/javascript",
        headers={"Content-Disposition": "inline; filename=quotex-instant-executor.user.js"}
    )


# ==============================================================================
# SERVER ENTRY POINT
# ==============================================================================

if __name__ == "__main__":
    import uvicorn
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "8000"))
    logger.info(f"Starting Quotex Autonomous Paper-Trading Agent at http://localhost:{port}")
    uvicorn.run("main:app", host=host, port=port, reload=False)
