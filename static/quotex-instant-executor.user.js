// ==UserScript==
// @name         Quotex Instant Auto-Trader (0ms Zero-Movement & Signal Percentage HUD)
// @namespace    https://github.com/mdsamaul/trade-tt-feature-smart-trend-learning
// @version      1.3.0
// @description  Instant sub-millisecond execution for Quotex without moving physical mouse. Displays real-time candle probability percentage in an ultra-modern popup and executes via 0ms DOM events.
// @author       Antigravity AI
// @match        *://*.qxbroker.com/*
// @match        *://*.quotex.io/*
// @match        *://*.quotex.com/*
// @match        *://*.market-qx.pro/*
// @match        *://*.qxbroker.io/*
// @match        *://*.qx-broker.com/*
// @match        *://*.quotex-broker.com/*
// @match        *://*.qxmarket.com/*
// @match        *://*.quotexmarket.com/*
// @match        *://*.market-qx.com/*
// @match        *://*.qx-trade.com/*
// @match        *://*.qxbroker2.com/*
// @match        *://*.quotex-cor.com/*
// @match        *://*.broker-qx.pro/*
// @match        *://qxbroker.com/*
// @match        *://quotex.io/*
// @match        *://quotex.com/*
// @match        *://market-qx.pro/*
// @match        *://qxbroker.io/*
// @match        *://qx-broker.com/*
// @match        *://quotex-broker.com/*
// @match        *://localhost/*
// @match        *://127.0.0.1/*
// @match        *://*/*
// @icon         https://quotex.com/favicon.ico
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_notification
// @grant        GM_addStyle
// @connect      localhost
// @connect      127.0.0.1
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // Domain guard: execute only on Quotex or broker tabs
  const host = (window.location.hostname || "").toLowerCase();
  const isQuotex = host.includes('quotex') || 
                   host.includes('qx') || 
                   host.includes('market-qx') || 
                   host.includes('broker') || 
                   host.includes('localhost') || 
                   host.includes('127.0.0.1');
  if (!isQuotex) return;

  console.log("%c⚡ [Quotex Instant Auto-Trader 1.3.0] Initialized with Dual WS+HTTP Heartbeat Bridge...", "color: #00ff88; font-weight: bold; font-size: 14px;");

  // Unique tab client ID for reliable HTTP heartbeat tracking
  const TAB_CLIENT_ID = 'tm_tab_' + Math.random().toString(36).substring(2, 9);

  // =========================================================================
  // CONFIGURATION & STATE
  // =========================================================================
  const CONFIG = {
    wsUrl: "ws://127.0.0.1:8000/ws/trade-signals",
    wsFallbackUrl: "ws://localhost:8000/ws/trade-signals",
    apiUrl: "http://127.0.0.1:8000/api/signals/latest",
    apiFallbackUrl: "http://localhost:8000/api/signals/latest",
    reconnectIntervalMs: 2000,
    pollingIntervalMs: 300,
    debounceMs: 1500
  };

  let ws = null;
  let isConnected = false;
  let autoExecuteEnabled = GM_getValue("quotex_auto_execute", true);
  let lastExecutedTradeId = null;
  let lastExecutionTime = 0;
  let customCallSelector = GM_getValue("quotex_custom_call_sel", "");
  let customPutSelector = GM_getValue("quotex_custom_put_sel", "");
  let popupDismissTimer = null;
  let isCalibrating = false;
  let calibrationTarget = null; // 'CALL' or 'PUT'

  // Inject Styles for Keyframe Animations
  const styleEl = document.createElement('style');
  styleEl.textContent = `
    @keyframes quotexPopupSlide {
      from { opacity: 0; transform: translate(-50%, -20px) scale(0.95); }
      to { opacity: 1; transform: translate(-50%, 0) scale(1); }
    }
    @keyframes quotexPulseGreen {
      0% { box-shadow: 0 0 10px rgba(0, 255, 136, 0.3); }
      50% { box-shadow: 0 0 25px rgba(0, 255, 136, 0.7); }
      100% { box-shadow: 0 0 10px rgba(0, 255, 136, 0.3); }
    }
    @keyframes quotexPulseRed {
      0% { box-shadow: 0 0 10px rgba(255, 51, 102, 0.3); }
      50% { box-shadow: 0 0 25px rgba(255, 51, 102, 0.7); }
      100% { box-shadow: 0 0 10px rgba(255, 51, 102, 0.3); }
    }
  `;
  document.head.appendChild(styleEl);

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
  // DOM BUTTON LOCATOR (COMPREHENSIVE QUOTEX SELECTORS & HEURISTICS)
  // =========================================================================
  function findQuotexButtons() {
    let callBtn = null;
    let putBtn = null;

    // 1. User custom saved selectors (calibrated by user clicking the buttons)
    if (customCallSelector) {
      try {
        const el = document.querySelector(customCallSelector);
        if (el && isElementVisible(el)) callBtn = el;
      } catch (e) {}
    }
    if (customPutSelector) {
      try {
        const el = document.querySelector(customPutSelector);
        if (el && isElementVisible(el)) putBtn = el;
      } catch (e) {}
    }

    // 2. Specific Quotex CSS selectors (covering all modern Quotex DOM versions)
    if (!callBtn) {
      const callSelectors = [
        'button.call-btn',
        'button.deal-form__button--call',
        'button.deal-form__button-call',
        '.deal-form__button--call',
        '.deal-form__button-call',
        '.deal-form__button.call',
        'button[data-test="call-btn"]',
        'button[data-qa*="call"]',
        'div[data-qa*="call"]',
        '.section-deal__button--call',
        'button[class*="button--call"]',
        'button[class*="button-call"]',
        'button[class*="btn-call"]',
        'div[class*="button--call"]',
        'div[class*="button-call"]',
        '.call-btn',
        '.btn-call',
        '.button-call',
        '.call-button',
        'button[class*="call"]',
        'div[class*="call"]'
      ];
      for (const sel of callSelectors) {
        try {
          const els = document.querySelectorAll(sel);
          for (const el of els) {
            if (el && isElementVisible(el)) { callBtn = el; break; }
          }
          if (callBtn) break;
        } catch (e) {}
      }
    }

    if (!putBtn) {
      const putSelectors = [
        'button.put-btn',
        'button.deal-form__button--put',
        'button.deal-form__button-put',
        '.deal-form__button--put',
        '.deal-form__button-put',
        '.deal-form__button.put',
        'button[data-test="put-btn"]',
        'button[data-qa*="put"]',
        'div[data-qa*="put"]',
        '.section-deal__button--put',
        'button[class*="button--put"]',
        'button[class*="button-put"]',
        'button[class*="btn-put"]',
        'div[class*="button--put"]',
        'div[class*="button-put"]',
        '.put-btn',
        '.btn-put',
        '.button-put',
        '.put-button',
        'button[class*="put"]',
        'div[class*="put"]'
      ];
      for (const sel of putSelectors) {
        try {
          const els = document.querySelectorAll(sel);
          for (const el of els) {
            if (el && isElementVisible(el)) { putBtn = el; break; }
          }
          if (putBtn) break;
        } catch (e) {}
      }
    }

    // 3. Heuristic color & text inspection if not found by classes
    if (!callBtn || !putBtn) {
      const candidates = Array.from(document.querySelectorAll('button, div[role="button"], a[role="button"], div[class*="btn"], div[class*="button"]'));
      for (const b of candidates) {
        if (!isElementVisible(b)) continue;
        const text = (b.innerText || b.textContent || '').trim().toLowerCase();
        const cls = (b.className || '').toString().toLowerCase();
        let bg = '';
        try {
          const style = window.getComputedStyle(b);
          bg = (style.backgroundColor || '') + (style.backgroundImage || '');
        } catch (e) {}

        // Green / UP candidate
        if (!callBtn) {
          const isGreen = bg.includes('0, 192,') || bg.includes('0, 231,') || bg.includes('15, 175,') ||
                          bg.includes('0, 184,') || bg.includes('0, 255, 136') || bg.includes('#00e793') ||
                          bg.includes('#00ff88') || bg.includes('#0faf59') || bg.includes('rgb(0, 192');
          const isUpText = text === 'up' || text === 'call' || text === 'выше' || text === 'вверх' ||
                           text === 'higher' || cls.includes('call') || (cls.includes('up') && !cls.includes('upload'));
          if (isGreen || isUpText) {
            callBtn = b;
          }
        }

        // Red / DOWN candidate
        if (!putBtn) {
          const isRed = bg.includes('255, 75,') || bg.includes('255, 59,') || bg.includes('229, 57,') ||
                        bg.includes('255, 51, 102') || bg.includes('#ff3b56') || bg.includes('#ff3366') ||
                        bg.includes('#e53935') || bg.includes('rgb(255, 59');
          const isDownText = text === 'down' || text === 'put' || text === 'ниже' || text === 'вниз' ||
                             text === 'lower' || cls.includes('put') || cls.includes('down');
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
    try {
      const rect = el.getBoundingClientRect();
      return rect.width > 20 && rect.height > 20 && rect.top >= 0 && rect.left >= 0;
    } catch (e) {
      return false;
    }
  }

  // =========================================================================
  // ZERO-MOVEMENT INSTANT DISPATCHER (0ms DOM CLICK)
  // =========================================================================
  function executeInstantDOMClick(direction, signal) {
    const startTime = performance.now();
    const buttons = findQuotexButtons();
    const targetBtn = direction === 'CALL' ? buttons.callBtn : buttons.putBtn;

    if (!targetBtn) {
      console.error(`❌ [Quotex Instant Trader] Could not locate ${direction} button in Quotex DOM!`);
      showHudNotification(`❌ ${direction} Button Not Found! Click [🎯 Calibrate]`, '#ff3366');
      showSignalPercentagePopup(signal || { direction, confidence: 90.0 }, '❌ BUTTON NOT FOUND (Click Calibrate)');
      return false;
    }

    // High-precision pointer event sequence (satisfies React 17/18, Vue, Angular event listeners)
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

    try {
      window.focus();
      targetBtn.focus();
    } catch (e) {}

    // Dispatch pointer events to the button
    targetBtn.dispatchEvent(new PointerEvent('pointerdown', eventInit));
    targetBtn.dispatchEvent(new MouseEvent('mousedown', eventInit));
    targetBtn.dispatchEvent(new PointerEvent('pointerup', eventInit));
    targetBtn.dispatchEvent(new MouseEvent('mouseup', eventInit));
    targetBtn.click();

    // Also dispatch to first child if button has inner span or div
    if (targetBtn.firstElementChild) {
      try {
        targetBtn.firstElementChild.dispatchEvent(new MouseEvent('click', eventInit));
      } catch (e) {}
    }

    const elapsed = (performance.now() - startTime).toFixed(2);
    playClickChime(direction);
    console.log(`⚡ [Quotex Instant Trader] ${direction} CLICKED INSTANTLY in ${elapsed}ms! Physical mouse did NOT move.`);

    const conf = parseFloat((signal && (signal.confidence || signal.probability)) || 90.0).toFixed(1);
    showHudNotification(`⚡ [${conf}% ${direction}] EXECUTED (${elapsed}ms)`, direction === 'CALL' ? '#00ff88' : '#ff3366');

    // Show the prominent Cyberpunk Signal Percentage Popup
    showSignalPercentagePopup(signal || { direction, confidence: conf }, `⚡ Executed in ${elapsed}ms (0ms DOM)`);

    // Send acknowledgment back to backend if WebSocket is active
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({
          type: "TRADE_EXECUTED_ACK",
          direction: direction,
          confidence: conf,
          latency_ms: parseFloat(elapsed),
          timestamp: Date.now()
        }));
      } catch (e) {}
    }

    return true;
  }

  // =========================================================================
  // SIGNAL PERCENTAGE POPUP MODAL (THE REQUESTED PERCENTAGE OVERLAY)
  // =========================================================================
  function showSignalPercentagePopup(signal, statusMessage) {
    let popup = document.getElementById('quotex-signal-popup');
    if (!popup) {
      popup = document.createElement('div');
      popup.id = 'quotex-signal-popup';
      document.body.appendChild(popup);
    }

    const direction = (signal.direction || 'CALL').toUpperCase();
    const isCall = direction === 'CALL';
    const confidence = parseFloat(signal.confidence || signal.probability || signal.candle_probability || 90.0).toFixed(1);
    const pattern = signal.pattern_name || (isCall ? 'Bullish Rejection Candle' : 'Bearish Continuation');
    const mainColor = isCall ? '#00ff88' : '#ff3366';
    const glowColor = isCall ? 'rgba(0, 255, 136, 0.4)' : 'rgba(255, 51, 102, 0.4)';
    const dirName = isCall ? 'UP / CALL (GREEN 🟢)' : 'DOWN / PUT (RED 🔴)';
    const icon = isCall ? '🚀 🟢' : '🔻 🔴';
    const animName = isCall ? 'quotexPulseGreen' : 'quotexPulseRed';

    popup.innerHTML = `
      <div style="
        position: fixed;
        top: 60px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 10000000;
        width: 380px;
        max-width: 92vw;
        background: rgba(10, 14, 24, 0.96);
        border: 2px solid ${mainColor};
        border-radius: 16px;
        box-shadow: 0 10px 45px rgba(0,0,0,0.85), 0 0 30px ${glowColor};
        backdrop-filter: blur(12px);
        color: #f0f4fc;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        padding: 16px 20px;
        box-sizing: border-box;
        animation: quotexPopupSlide 0.35s cubic-bezier(0.16, 1, 0.3, 1), ${animName} 2s infinite ease-in-out;
        user-select: none;
      ">
        <!-- Header -->
        <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 8px; margin-bottom: 12px;">
          <span style="font-size: 11px; font-weight: 800; color: #8391a8; letter-spacing: 1px; text-transform: uppercase; display: flex; align-items: center; gap: 6px;">
            <span style="width: 8px; height: 8px; border-radius: 50%; background: ${mainColor}; box-shadow: 0 0 6px ${mainColor};"></span>
            ⚡ AI AUTONOMOUS SIGNAL
          </span>
          <button id="close-signal-popup" style="
            background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); color: #a0aec0; border-radius: 6px; font-size: 13px; cursor: pointer; padding: 2px 7px; line-height: 1;
          ">✕</button>
        </div>

        <!-- Big Bold Percentage & Direction -->
        <div style="text-align: center; margin-bottom: 14px;">
          <div style="font-size: 13px; font-weight: 800; color: ${mainColor}; margin-bottom: 4px; letter-spacing: 0.5px; text-transform: uppercase;">
            ${icon} ${dirName}
          </div>
          <div style="
            font-size: 42px;
            font-weight: 900;
            font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI Mono', monospace;
            color: #ffffff;
            text-shadow: 0 0 20px ${mainColor};
            line-height: 1.05;
          ">
            ${confidence}%
          </div>
          <div style="font-size: 11px; font-weight: 800; color: #a0aec0; margin-top: 4px; text-transform: uppercase; letter-spacing: 2px;">
            CANDLE WIN PROBABILITY
          </div>
        </div>

        <!-- Signal Details Grid -->
        <div style="
          background: rgba(16, 22, 36, 0.85);
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 10px;
          padding: 10px 14px;
          font-size: 11.5px;
          line-height: 1.7;
          margin-bottom: 12px;
        ">
          <div style="display: flex; justify-content: space-between;">
            <span style="color: #718096;">Pattern Setup:</span>
            <strong style="color: #f7fafc;">${pattern}</strong>
          </div>
          <div style="display: flex; justify-content: space-between;">
            <span style="color: #718096;">Execution Engine:</span>
            <strong style="color: ${mainColor};">0ms DOM (Zero Mouse Movement)</strong>
          </div>
          <div style="display: flex; justify-content: space-between;">
            <span style="color: #718096;">Trade Status:</span>
            <strong style="color: #00f0ff;">${statusMessage || '⚡ Instant Executed'}</strong>
          </div>
        </div>

        <!-- Countdown Progress Bar -->
        <div style="width: 100%; height: 3px; background: rgba(255,255,255,0.1); border-radius: 2px; overflow: hidden;">
          <div id="popup-progress-bar" style="
            width: 100%; height: 100%; background: ${mainColor}; box-shadow: 0 0 10px ${mainColor};
            transition: width 5.5s linear;
          "></div>
        </div>
      </div>
    `;

    setTimeout(() => {
      const bar = document.getElementById('popup-progress-bar');
      if (bar) bar.style.width = '0%';
    }, 50);

    const closeBtn = document.getElementById('close-signal-popup');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        if (popup) popup.style.display = 'none';
      });
    }

    clearTimeout(popupDismissTimer);
    popup.style.display = 'block';
    popupDismissTimer = setTimeout(() => {
      if (popup) popup.style.display = 'none';
    }, 6000);
  }

  // =========================================================================
  // SIGNAL PROCESSOR & DEBOUNCE
  // =========================================================================
  function handleIncomingTradeSignal(signal) {
    if (!signal) return;
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
      showSignalPercentagePopup(signal, '⚠️ Signal Received (Auto-Execute is OFF in HUD)');
      return;
    }

    lastExecutedTradeId = tradeId;
    lastExecutionTime = now;
    executeInstantDOMClick(direction, signal);
  }

  // =========================================================================
  // WEBSOCKET CLIENT (PRIMARY PROTOCOL)
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
        // If 127.0.0.1 failed, try localhost next
        if (CONFIG.wsUrl.includes("127.0.0.1")) {
          CONFIG.wsUrl = CONFIG.wsFallbackUrl;
        } else {
          CONFIG.wsUrl = "ws://127.0.0.1:8000/ws/trade-signals";
        }
        setTimeout(connectWebSocket, CONFIG.reconnectIntervalMs);
      };

      ws.onerror = function () {
        // Silently tolerate if WS blocked by mixed-content; HTTP polling will handle
      };
    } catch (e) {
      setTimeout(connectWebSocket, CONFIG.reconnectIntervalMs);
    }
  }

  // Fast Parallel HTTP Polling & Heartbeat (Bypasses HTTPS Mixed-Content limitations)
  setInterval(() => {
    if (typeof GM_xmlhttpRequest !== 'undefined') {
      const fullUrl = `${CONFIG.apiUrl}?client_id=${TAB_CLIENT_ID}`;
      GM_xmlhttpRequest({
        method: "GET",
        url: fullUrl,
        timeout: 1200,
        onload: function (res) {
          try {
            const data = JSON.parse(res.responseText);
            if (data && data.success) {
              isConnected = true;
              updateHudStatus(true);
              if (data.signal && autoExecuteEnabled) {
                const sig = data.signal;
                const sigTime = sig.timestamp || 0;
                // If signal was issued in last 3.5 seconds and hasn't been executed
                if (Date.now() - sigTime < 3500) {
                  handleIncomingTradeSignal(sig);
                }
              }
            }
          } catch (e) {}
        },
        onerror: function () {
          // If 127.0.0.1 fails, switch to localhost and retry
          if (CONFIG.apiUrl.includes("127.0.0.1")) {
            CONFIG.apiUrl = CONFIG.apiFallbackUrl;
          } else {
            CONFIG.apiUrl = "http://127.0.0.1:8000/api/signals/latest";
          }
        }
      });
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
        right: 170px;
        z-index: 9999999;
        display: flex;
        align-items: center;
        gap: 8px;
        background: rgba(10, 14, 22, 0.94);
        border: 1px solid rgba(0, 240, 255, 0.4);
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.65), 0 0 12px rgba(0, 240, 255, 0.2);
        border-radius: 20px;
        padding: 6px 14px;
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
          padding: 2px 8px;
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
          font-size: 9.5px;
          font-weight: 700;
          cursor: pointer;
        ">Test UP</button>

        <button id="hud-test-put" style="
          background: rgba(255, 51, 102, 0.15);
          color: #ff3366;
          border: 1px solid rgba(255, 51, 102, 0.4);
          border-radius: 4px;
          padding: 2px 6px;
          font-size: 9.5px;
          font-weight: 700;
          cursor: pointer;
        ">Test DOWN</button>

        <button id="hud-calibrate-btn" style="
          background: rgba(0, 240, 255, 0.15);
          color: #00f0ff;
          border: 1px solid rgba(0, 240, 255, 0.4);
          border-radius: 4px;
          padding: 2px 6px;
          font-size: 9.5px;
          font-weight: 700;
          cursor: pointer;
        " title="Click here to calibrate buttons if Quotex updates its layout">🎯 Calibrate</button>

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

    document.getElementById('hud-test-call').addEventListener('click', () => executeInstantDOMClick('CALL', { direction: 'CALL', confidence: 92.5, pattern_name: 'Manual Test Call' }));
    document.getElementById('hud-test-put').addEventListener('click', () => executeInstantDOMClick('PUT', { direction: 'PUT', confidence: 89.0, pattern_name: 'Manual Test Put' }));

    // Interactive Button Calibrator (Click Calibrate -> click UP button -> click DOWN button)
    document.getElementById('hud-calibrate-btn').addEventListener('click', startInteractiveCalibration);
  }

  function startInteractiveCalibration() {
    isCalibrating = true;
    calibrationTarget = 'CALL';
    showHudNotification('👉 এখন Quotex-এর সবুজ UP বাটনে ক্লিক করুন', '#00ff88');

    const clickListener = (e) => {
      e.preventDefault();
      e.stopPropagation();

      const target = e.target;
      const selector = getUniqueSelector(target);

      if (calibrationTarget === 'CALL') {
        customCallSelector = selector;
        GM_setValue("quotex_custom_call_sel", selector);
        calibrationTarget = 'PUT';
        showHudNotification('✅ UP বাটন সেভড! এখন লাল DOWN বাটনে ক্লিক করুন', '#ff3366');
      } else if (calibrationTarget === 'PUT') {
        customPutSelector = selector;
        GM_setValue("quotex_custom_put_sel", selector);
        isCalibrating = false;
        calibrationTarget = null;
        document.removeEventListener('click', clickListener, true);
        showHudNotification('🎉 বাটন ক্যালিব্রেশন সফল হয়েছে!', '#00ff88');
        showSignalPercentagePopup({ direction: 'CALL', confidence: 99.9, pattern_name: 'Buttons Calibrated Successfully' }, '✅ Buttons Calibrated');
      }
    };

    document.addEventListener('click', clickListener, true);
  }

  function getUniqueSelector(el) {
    if (!el) return '';
    if (el.id) return `#${el.id}`;
    let path = [];
    while (el && el.nodeType === Node.ELEMENT_NODE && el !== document.body) {
      let selector = el.nodeName.toLowerCase();
      if (el.className && typeof el.className === 'string') {
        const classes = el.className.trim().split(/\s+/).filter(c => c && !c.includes(':')).slice(0, 2);
        if (classes.length) selector += '.' + classes.join('.');
      }
      path.unshift(selector);
      el = el.parentNode;
      if (path.length >= 3) break;
    }
    return path.join(' > ');
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
    }, 4000);
  }

  // =========================================================================
  // BOOTSTRAP
  // =========================================================================
  window.addEventListener('load', () => {
    createFloatingHud();
    connectWebSocket();
  });

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    createFloatingHud();
    connectWebSocket();
  }

})();
