// ==UserScript==
// @name         Quotex Instant Auto-Trader (0ms Zero-Movement)
// @namespace    https://github.com/mdsamaul/trade-tt-feature-smart-trend-learning
// @version      1.0.0
// @description  Instant sub-millisecond execution for Quotex without moving physical mouse. Communicates directly with local AI Trading Agent backend via WebSocket & HTTP.
// @author       Antigravity AI
// @match        https://qxbroker.com/*
// @match        https://quotex.io/*
// @match        https://quotex.com/*
// @match        https://market-qx.pro/*
// @match        https://qxbroker.io/*
// @match        https://qx-broker.com/*
// @match        https://quotex-broker.com/*
// @icon         https://quotex.com/favicon.ico
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_notification
// @connect      localhost
// @connect      127.0.0.1
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  console.log("%c⚡ [Quotex Instant Auto-Trader] Initializing Tampermonkey 5.5.1 userscript...", "color: #00ff88; font-weight: bold; font-size: 14px;");

  // =========================================================================
  // CONFIGURATION & STATE
  // =========================================================================
  const CONFIG = {
    wsUrl: "ws://localhost:8000/ws/trade-signals",
    apiUrl: "http://localhost:8000/api/signals/latest",
    reconnectIntervalMs: 2000,
    pollingIntervalMs: 250,
    debounceMs: 1500
  };

  let ws = null;
  let isConnected = false;
  let autoExecuteEnabled = GM_getValue("quotex_auto_execute", true);
  let lastExecutedTradeId = null;
  let lastExecutionTime = 0;
  let customCallSelector = GM_getValue("quotex_custom_call_sel", "");
  let customPutSelector = GM_getValue("quotex_custom_put_sel", "");

  // Audio synthesizer for instant feedback
  const audioCtx = (typeof AudioContext !== 'undefined') ? new (window.AudioContext || window.webkitAudioContext)() : null;
  function playClickChime(direction) {
    if (!audioCtx) return;
    try {
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      const now = audioCtx.currentTime;
      if (direction === 'CALL') {
        osc.frequency.setValueAtTime(523.25, now); // C5
        osc.frequency.exponentialRampToValueAtTime(880.00, now + 0.12); // A5
      } else {
        osc.frequency.setValueAtTime(659.25, now); // E5
        osc.frequency.exponentialRampToValueAtTime(440.00, now + 0.12); // A4
      }
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
      osc.start(now);
      osc.stop(now + 0.16);
    } catch (e) {
      // Audio error ignored
    }
  }

  // =========================================================================
  // DOM BUTTON LOCATOR
  // =========================================================================
  function findQuotexButtons() {
    let callBtn = null;
    let putBtn = null;

    // 1. User custom saved selectors (if calibrated)
    if (customCallSelector) {
      callBtn = document.querySelector(customCallSelector);
    }
    if (customPutSelector) {
      putBtn = document.querySelector(customPutSelector);
    }

    // 2. Specific Quotex CSS selectors
    if (!callBtn) {
      const callSelectors = [
        'button.call-btn',
        'button.deal-form__button--call',
        'button[data-test="call-btn"]',
        '.section-deal__button--call',
        'button[class*="button--call"]',
        'button[class*="button-call"]',
        'button[class*="btn-call"]'
      ];
      for (const sel of callSelectors) {
        const el = document.querySelector(sel);
        if (el && isElementVisible(el)) { callBtn = el; break; }
      }
    }

    if (!putBtn) {
      const putSelectors = [
        'button.put-btn',
        'button.deal-form__button--put',
        'button[data-test="put-btn"]',
        '.section-deal__button--put',
        'button[class*="button--put"]',
        'button[class*="button-put"]',
        'button[class*="btn-put"]'
      ];
      for (const sel of putSelectors) {
        const el = document.querySelector(sel);
        if (el && isElementVisible(el)) { putBtn = el; break; }
      }
    }

    // 3. Heuristic color & text inspection if not found by classes
    if (!callBtn || !putBtn) {
      const allButtons = Array.from(document.querySelectorAll('button, div[role="button"], a[role="button"]'));
      for (const b of allButtons) {
        if (!isElementVisible(b)) continue;
        const text = (b.innerText || b.textContent || '').trim().toLowerCase();
        const cls = (b.className || '').toString().toLowerCase();
        const style = window.getComputedStyle(b);
        const bg = (style.backgroundColor || '') + (style.backgroundImage || '');

        // Green / UP candidate
        if (!callBtn) {
          const isGreen = bg.includes('0, 192,') || bg.includes('0, 231,') || bg.includes('15, 175,') || bg.includes('#00e793') || bg.includes('#00ff88');
          const isUpText = text === 'up' || text === 'call' || text === 'выше' || text === 'вверх' || cls.includes('call') || cls.includes('up');
          if (isGreen || isUpText) {
            callBtn = b;
          }
        }

        // Red / DOWN candidate
        if (!putBtn) {
          const isRed = bg.includes('255, 75,') || bg.includes('255, 59,') || bg.includes('229, 57,') || bg.includes('#ff3b56') || bg.includes('#ff3366');
          const isDownText = text === 'down' || text === 'put' || text === 'ниже' || text === 'вниз' || cls.includes('put') || cls.includes('down');
          if (isRed || isDownText) {
            putBtn = b;
          }
        }
      }
    }

    return { callBtn, putBtn };
  }

  function isElementVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 15 && rect.height > 15 && rect.top >= 0 && rect.left >= 0;
  }

  // =========================================================================
  // ZERO-MOVEMENT INSTANT DISPATCHER (0ms DOM CLICK)
  // =========================================================================
  function executeInstantDOMClick(direction) {
    const startTime = performance.now();
    const buttons = findQuotexButtons();
    const targetBtn = direction === 'CALL' ? buttons.callBtn : buttons.putBtn;

    if (!targetBtn) {
      console.error(`❌ [Quotex Instant Trader] Could not locate ${direction} button in Quotex DOM!`);
      showHudNotification(`❌ ${direction} Button Not Found! Click [Calibrate]`, '#ff3366');
      return false;
    }

    // High-precision pointer event sequence (satisfies React, Vue, Angular event listeners)
    const rect = targetBtn.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;

    const eventInit = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: clientX,
      clientY: clientY,
      screenX: window.screenX + clientX,
      screenY: window.screenY + clientY,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      buttons: 1
    };

    targetBtn.focus();
    targetBtn.dispatchEvent(new PointerEvent('pointerdown', eventInit));
    targetBtn.dispatchEvent(new MouseEvent('mousedown', eventInit));
    targetBtn.dispatchEvent(new PointerEvent('pointerup', eventInit));
    targetBtn.dispatchEvent(new MouseEvent('mouseup', eventInit));
    targetBtn.click();

    const elapsed = (performance.now() - startTime).toFixed(2);
    playClickChime(direction);
    console.log(`⚡ [Quotex Instant Trader] ${direction} CLICKED INSTANTLY in ${elapsed}ms! Physical mouse did NOT move.`);
    showHudNotification(`⚡ ${direction} EXECUTED (${elapsed}ms)`, direction === 'CALL' ? '#00ff88' : '#ff3366');

    // Send acknowledgment back to backend if WebSocket is active
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({
          type: "TRADE_EXECUTED_ACK",
          direction: direction,
          latency_ms: parseFloat(elapsed),
          timestamp: Date.now()
        }));
      } catch (e) {}
    }

    return true;
  }

  // =========================================================================
  // SIGNAL PROCESSOR & DEBOUNCE
  // =========================================================================
  function handleIncomingTradeSignal(signal) {
    if (!signal || signal.action !== 'EXECUTE') return;
    const direction = (signal.direction || '').toUpperCase();
    if (direction !== 'CALL' && direction !== 'PUT') return;

    const tradeId = signal.trade_id || `${direction}_${signal.timestamp || Date.now()}`;
    const now = Date.now();

    // Prevent duplicate clicks on the exact same signal
    if (lastExecutedTradeId === tradeId && (now - lastExecutionTime) < CONFIG.debounceMs) {
      return;
    }

    if (!autoExecuteEnabled) {
      console.log(`ℹ️ [Quotex Instant Trader] Trade signal ${direction} received, but auto-execution is disabled in HUD.`);
      showHudNotification(`🔔 Signal: ${direction} (Auto-Execute OFF)`, '#ffb800');
      return;
    }

    lastExecutedTradeId = tradeId;
    lastExecutionTime = now;
    executeInstantDOMClick(direction);
  }

  // =========================================================================
  // WEBSOCKET CLIENT (PRIMARY ULTRA-FAST PROTOCOL)
  // =========================================================================
  function connectWebSocket() {
    try {
      ws = new WebSocket(CONFIG.wsUrl);

      ws.onopen = function () {
        isConnected = true;
        updateHudStatus(true);
        console.log("%c⚡ [Quotex Instant Trader] Connected to AI Agent WebSocket!", "color: #00ff88; font-weight: bold;");
      };

      ws.onmessage = function (event) {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'TRADE_SIGNAL') {
            handleIncomingTradeSignal(msg);
          }
        } catch (e) {
          console.error("Signal parsing error:", e);
        }
      };

      ws.onclose = function () {
        isConnected = false;
        updateHudStatus(false);
        setTimeout(connectWebSocket, CONFIG.reconnectIntervalMs);
      };

      ws.onerror = function () {
        isConnected = false;
        updateHudStatus(false);
      };
    } catch (e) {
      isConnected = false;
      updateHudStatus(false);
      setTimeout(connectWebSocket, CONFIG.reconnectIntervalMs);
    }
  }

  // Fast HTTP Polling Fallback (Bypasses any browser WebSocket limits)
  setInterval(() => {
    if (!isConnected && autoExecuteEnabled) {
      if (typeof GM_xmlhttpRequest !== 'undefined') {
        GM_xmlhttpRequest({
          method: "GET",
          url: CONFIG.apiUrl,
          timeout: 1000,
          onload: function (res) {
            try {
              const data = JSON.parse(res.responseText);
              if (data && data.signal) {
                handleIncomingTradeSignal(data.signal);
              }
            } catch (e) {}
          }
        });
      }
    }
  }, CONFIG.pollingIntervalMs);

  // =========================================================================
  // CYBERPUNK FLOATING HUD ON QUOTEX CANVAS
  // =========================================================================
  let hudContainer, statusBadge, notifText, autoToggleBtn;

  function createFloatingHud() {
    if (document.getElementById('quotex-agent-hud')) return;

    hudContainer = document.createElement('div');
    hudContainer.id = 'quotex-agent-hud';
    hudContainer.innerHTML = `
      <div style="
        position: fixed;
        top: 14px;
        right: 180px;
        z-index: 9999999;
        display: flex;
        align-items: center;
        gap: 8px;
        background: rgba(10, 14, 22, 0.92);
        border: 1px solid rgba(0, 240, 255, 0.4);
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.6), 0 0 10px rgba(0, 240, 255, 0.15);
        border-radius: 20px;
        padding: 5px 12px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 11px;
        color: #f0f4fc;
        user-select: none;
        backdrop-filter: blur(8px);
        transition: all 0.25s ease;
      " id="quotex-hud-pill">
        <span id="hud-status-dot" style="
          width: 8px; height: 8px; border-radius: 50%; background: #ff3366;
          box-shadow: 0 0 8px #ff3366; display: inline-block;
        "></span>
        <span id="hud-status-text" style="font-weight: 700; color: #8391a8;">CONNECTING...</span>
        
        <span style="color: rgba(255,255,255,0.2);">|</span>

        <button id="hud-auto-toggle" style="
          background: ${autoExecuteEnabled ? 'rgba(0, 255, 136, 0.2)' : 'rgba(255, 51, 102, 0.2)'};
          color: ${autoExecuteEnabled ? '#00ff88' : '#ff3366'};
          border: 1px solid ${autoExecuteEnabled ? '#00ff88' : '#ff3366'};
          border-radius: 10px;
          padding: 2px 7px;
          font-size: 10px;
          font-weight: 800;
          cursor: pointer;
        ">INSTANT: ${autoExecuteEnabled ? 'ON' : 'OFF'}</button>

        <span style="color: rgba(255,255,255,0.2);">|</span>

        <button id="hud-test-call" style="
          background: rgba(0, 255, 136, 0.15);
          color: #00ff88;
          border: 1px solid rgba(0, 255, 136, 0.4);
          border-radius: 4px;
          padding: 2px 6px;
          font-size: 9px;
          font-weight: 700;
          cursor: pointer;
        ">Test UP</button>

        <button id="hud-test-put" style="
          background: rgba(255, 51, 102, 0.15);
          color: #ff3366;
          border: 1px solid rgba(255, 51, 102, 0.4);
          border-radius: 4px;
          padding: 2px 6px;
          font-size: 9px;
          font-weight: 700;
          cursor: pointer;
        ">Test DOWN</button>

        <span id="hud-notif" style="display: none; font-weight: bold; margin-left: 4px;"></span>
      </div>
    `;

    document.body.appendChild(hudContainer);

    statusBadge = document.getElementById('hud-status-text');
    notifText = document.getElementById('hud-notif');
    autoToggleBtn = document.getElementById('hud-auto-toggle');

    autoToggleBtn.addEventListener('click', () => {
      autoExecuteEnabled = !autoExecuteEnabled;
      GM_setValue("quotex_auto_execute", autoExecuteEnabled);
      autoToggleBtn.style.background = autoExecuteEnabled ? 'rgba(0, 255, 136, 0.2)' : 'rgba(255, 51, 102, 0.2)';
      autoToggleBtn.style.color = autoExecuteEnabled ? '#00ff88' : '#ff3366';
      autoToggleBtn.style.borderColor = autoExecuteEnabled ? '#00ff88' : '#ff3366';
      autoToggleBtn.textContent = `INSTANT: ${autoExecuteEnabled ? 'ON' : 'OFF'}`;
      showHudNotification(autoExecuteEnabled ? 'Instant DOM Auto-Trade ENABLED' : 'Auto-Trade PAUSED', autoExecuteEnabled ? '#00ff88' : '#ffb800');
    });

    document.getElementById('hud-test-call').addEventListener('click', () => executeInstantDOMClick('CALL'));
    document.getElementById('hud-test-put').addEventListener('click', () => executeInstantDOMClick('PUT'));
  }

  function updateHudStatus(connected) {
    const dot = document.getElementById('hud-status-dot');
    const txt = document.getElementById('hud-status-text');
    if (!dot || !txt) return;

    if (connected) {
      dot.style.background = '#00ff88';
      dot.style.boxShadow = '0 0 8px #00ff88';
      txt.textContent = 'AGENT CONNECTED (0ms DOM)';
      txt.style.color = '#00ff88';
    } else {
      dot.style.background = '#ff3366';
      dot.style.boxShadow = '0 0 8px #ff3366';
      txt.textContent = 'OFFLINE (RECONNECTING...)';
      txt.style.color = '#ff3366';
    }
  }

  let notifTimeout = null;
  function showHudNotification(text, color) {
    if (!notifText) return;
    notifText.textContent = text;
    notifText.style.color = color || '#00f0ff';
    notifText.style.display = 'inline-block';
    clearTimeout(notifTimeout);
    notifTimeout = setTimeout(() => {
      if (notifText) notifText.style.display = 'none';
    }, 3000);
  }

  // =========================================================================
  // BOOTSTRAP
  // =========================================================================
  window.addEventListener('load', () => {
    createFloatingHud();
    connectWebSocket();
  });

  // Also check if document is already loaded
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    createFloatingHud();
    connectWebSocket();
  }

})();
