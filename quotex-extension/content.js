/**
 * Quotex Instant Auto-Trader - Native Chrome Extension Content Script
 * Runs natively inside Quotex (market-qx.info, qxbroker.com, etc.)
 * Provides 0ms instant DOM execution and live floating HUD.
 */

(function () {
  'use strict';

  // Domain guard: run only on Quotex domains or localhost
  const host = (window.location.hostname || "").toLowerCase();
  const isQuotex = host.includes('quotex') || 
                   host.includes('qx') || 
                   host.includes('market-qx') || 
                   host.includes('broker') || 
                   host.includes('localhost') || 
                   host.includes('127.0.0.1');
  if (!isQuotex) return;

  console.log("%c⚡ [Quotex Native Auto-Trader 1.3.0] Initialized with 0ms DOM Execution...", "color: #00ff88; font-weight: bold; font-size: 14px;");

  const TAB_CLIENT_ID = 'ext_tab_' + Math.random().toString(36).substring(2, 9);

  const CONFIG = {
    wsUrl: "ws://127.0.0.1:8000/ws/trade-signals",
    wsFallbackUrl: "ws://localhost:8000/ws/trade-signals",
    apiUrl: "http://127.0.0.1:8000/api/signals/latest",
    apiFallbackUrl: "http://localhost:8000/api/signals/latest",
    reconnectIntervalMs: 2000,
    pollingIntervalMs: 250,
    debounceMs: 1500
  };

  let ws = null;
  let isConnected = false;
  let autoExecuteEnabled = true;
  let lastExecutedTradeId = null;
  let lastExecutionTime = 0;
  let customCallSelector = "";
  let customPutSelector = "";

  // Inject Styles
  const styleEl = document.createElement('style');
  styleEl.textContent = `
    @keyframes quotexPopupSlide {
      from { opacity: 0; transform: translate(-50%, -20px) scale(0.95); }
      to { opacity: 1; transform: translate(-50%, 0) scale(1); }
    }
  `;
  document.head ? document.head.appendChild(styleEl) : document.documentElement.appendChild(styleEl);

  // Audio synthesizer
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
      osc.frequency.setValueAtTime(direction === 'CALL' ? 650 : 440, now);
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
      osc.start(now);
      osc.stop(now + 0.16);
    } catch (e) {}
  }

  // Button Finder
  function findQuotexButtons() {
    let callBtn = null;
    let putBtn = null;

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

    const callSelectors = [
      'button.call-btn',
      'button.deal-form__button--call',
      'button.deal-form__button-call',
      '.deal-form__button--call',
      '.deal-form__button-call',
      'button[data-test="call-btn"]',
      '.section-deal__button--call',
      'button[class*="button--call"]',
      'button[class*="button-call"]',
      'button[class*="btn-call"]'
    ];
    if (!callBtn) {
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

    const putSelectors = [
      'button.put-btn',
      'button.deal-form__button--put',
      'button.deal-form__button-put',
      '.deal-form__button--put',
      '.deal-form__button-put',
      'button[data-test="put-btn"]',
      '.section-deal__button--put',
      'button[class*="button--put"]',
      'button[class*="button-put"]',
      'button[class*="btn-put"]'
    ];
    if (!putBtn) {
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

    // Heuristic inspection: Search text "Buy" / "Up" and "Sell" / "Down"
    if (!callBtn || !putBtn) {
      const candidates = Array.from(document.querySelectorAll('button, div[role="button"], a[role="button"], div[class*="btn"]'));
      for (const b of candidates) {
        if (!isElementVisible(b)) continue;
        const text = (b.innerText || b.textContent || '').trim().toLowerCase();
        const cls = (b.className || '').toString().toLowerCase();

        if (!callBtn) {
          const isUpText = text.includes('buy') || text === 'up' || text === 'call' || text === 'выше' || text === 'higher' || (cls.includes('call') && !cls.includes('callback'));
          if (isUpText) callBtn = b;
        }

        if (!putBtn) {
          const isDownText = text.includes('sell') || text === 'down' || text === 'put' || text === 'ниже' || text === 'lower' || cls.includes('put');
          if (isDownText) putBtn = b;
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

  function executeInstantDOMClick(direction, signal) {
    const buttons = findQuotexButtons();
    const targetBtn = direction === 'CALL' ? buttons.callBtn : buttons.putBtn;

    if (!targetBtn) {
      console.error(`❌ [Quotex Native Trader] Could not locate ${direction} button!`);
      showHudNotification(`❌ ${direction} Button Not Found! Click [🎯 Calibrate]`, '#ff3366');
      return false;
    }

    const rect = targetBtn.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;

    const eventInit = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: clientX,
      clientY: clientY,
      button: 0,
      buttons: 1
    };

    try {
      targetBtn.dispatchEvent(new PointerEvent('pointerdown', eventInit));
      targetBtn.dispatchEvent(new MouseEvent('mousedown', eventInit));
      targetBtn.dispatchEvent(new PointerEvent('pointerup', eventInit));
      targetBtn.dispatchEvent(new MouseEvent('mouseup', eventInit));
      targetBtn.dispatchEvent(new MouseEvent('click', eventInit));

      playClickChime(direction);
      console.log(`⚡ [Quotex Native Trader] EXECUTED ${direction} DOM CLICK in 0ms!`);
      showHudNotification(`⚡ EXECUTED ${direction} (${signal.confidence || 90}%)`, direction === 'CALL' ? '#00ff88' : '#ff3366');
      return true;
    } catch (e) {
      console.error("Click error:", e);
      return false;
    }
  }

  function handleIncomingTradeSignal(signal) {
    if (!signal || signal.action !== 'EXECUTE') return;
    const direction = (signal.direction || '').toUpperCase();
    if (direction !== 'CALL' && direction !== 'PUT') return;

    const tradeId = signal.trade_id || `${direction}_${signal.timestamp || Date.now()}`;
    const now = Date.now();
    if (lastExecutedTradeId === tradeId && (now - lastExecutionTime) < CONFIG.debounceMs) return;

    if (!autoExecuteEnabled) {
      showHudNotification(`🔔 Signal: ${direction} (Auto-Execute OFF)`, '#ffb800');
      return;
    }

    lastExecutedTradeId = tradeId;
    lastExecutionTime = now;
    executeInstantDOMClick(direction, signal);
  }

  // WebSocket
  function connectWebSocket() {
    try {
      ws = new WebSocket(CONFIG.wsUrl);
      ws.onopen = function () {
        isConnected = true;
        updateHudStatus(true);
      };
      ws.onmessage = function (event) {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'TRADE_SIGNAL') handleIncomingTradeSignal(msg);
        } catch (e) {}
      };
      ws.onclose = function () {
        if (CONFIG.wsUrl.includes("127.0.0.1")) CONFIG.wsUrl = CONFIG.wsFallbackUrl;
        else CONFIG.wsUrl = "ws://127.0.0.1:8000/ws/trade-signals";
        setTimeout(connectWebSocket, CONFIG.reconnectIntervalMs);
      };
      ws.onerror = function () {};
    } catch (e) {
      setTimeout(connectWebSocket, CONFIG.reconnectIntervalMs);
    }
  }

  // HTTP Polling & Heartbeat
  setInterval(async () => {
    try {
      const fullUrl = `${CONFIG.apiUrl}?client_id=${TAB_CLIENT_ID}`;
      const res = await fetch(fullUrl, { method: "GET" });
      const data = await res.json();
      if (data && data.success) {
        isConnected = true;
        updateHudStatus(true);
        if (data.signal && autoExecuteEnabled) {
          const sig = data.signal;
          const sigTime = sig.timestamp || 0;
          if (Date.now() - sigTime < 3500) {
            handleIncomingTradeSignal(sig);
          }
        }
      }
    } catch (e) {
      if (CONFIG.apiUrl.includes("127.0.0.1")) CONFIG.apiUrl = CONFIG.apiFallbackUrl;
      else CONFIG.apiUrl = "http://127.0.0.1:8000/api/signals/latest";
    }
  }, CONFIG.pollingIntervalMs);

  // Floating HUD
  let hudContainer, notifText, autoToggleBtn;

  function createFloatingHud() {
    if (document.getElementById('quotex-agent-hud')) return;

    hudContainer = document.createElement('div');
    hudContainer.id = 'quotex-agent-hud';
    hudContainer.innerHTML = `
      <div style="
        position: fixed;
        bottom: 18px;
        left: 20px;
        z-index: 9999999;
        display: flex;
        align-items: center;
        gap: 8px;
        background: rgba(10, 14, 22, 0.95);
        border: 1px solid rgba(0, 240, 255, 0.4);
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.7), 0 0 12px rgba(0, 240, 255, 0.2);
        border-radius: 20px;
        padding: 7px 16px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 11px;
        color: #f0f4fc;
        user-select: none;
        backdrop-filter: blur(8px);
      ">
        <span id="hud-status-dot" style="
          width: 9px; height: 9px; border-radius: 50%; background: #00ff88;
          box-shadow: 0 0 8px #00ff88; display: inline-block;
        "></span>
        <span id="hud-status-text" style="font-weight: 700; color: #00ff88;">AGENT CONNECTED (0ms DOM)</span>
        
        <span style="color: rgba(255,255,255,0.2);">|</span>

        <button id="hud-auto-toggle" style="
          background: rgba(0, 255, 136, 0.2);
          color: #00ff88;
          border: 1px solid #00ff88;
          border-radius: 10px;
          padding: 2px 8px;
          font-size: 10px;
          font-weight: 800;
          cursor: pointer;
        ">INSTANT: ON</button>

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
        ">Test BUY</button>

        <button id="hud-test-put" style="
          background: rgba(255, 51, 102, 0.15);
          color: #ff3366;
          border: 1px solid rgba(255, 51, 102, 0.4);
          border-radius: 4px;
          padding: 2px 6px;
          font-size: 9.5px;
          font-weight: 700;
          cursor: pointer;
        ">Test SELL</button>

        <span id="hud-notif" style="display: none; font-weight: bold; margin-left: 4px;"></span>
      </div>
    `;

    document.body ? document.body.appendChild(hudContainer) : document.documentElement.appendChild(hudContainer);

    notifText = document.getElementById('hud-notif');
    autoToggleBtn = document.getElementById('hud-auto-toggle');

    autoToggleBtn.addEventListener('click', () => {
      autoExecuteEnabled = !autoExecuteEnabled;
      autoToggleBtn.style.background = autoExecuteEnabled ? 'rgba(0, 255, 136, 0.2)' : 'rgba(255, 51, 102, 0.2)';
      autoToggleBtn.style.color = autoExecuteEnabled ? '#00ff88' : '#ff3366';
      autoToggleBtn.style.borderColor = autoExecuteEnabled ? '#00ff88' : '#ff3366';
      autoToggleBtn.textContent = `INSTANT: ${autoExecuteEnabled ? 'ON' : 'OFF'}`;
      showHudNotification(autoExecuteEnabled ? 'Instant DOM Auto-Trade ENABLED' : 'Auto-Trade PAUSED', autoExecuteEnabled ? '#00ff88' : '#ffb800');
    });

    document.getElementById('hud-test-call').addEventListener('click', () => executeInstantDOMClick('CALL', { direction: 'CALL', confidence: 95.0 }));
    document.getElementById('hud-test-put').addEventListener('click', () => executeInstantDOMClick('PUT', { direction: 'PUT', confidence: 92.0 }));
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
      txt.textContent = 'CONNECTING...';
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

  // Bootstrap
  setTimeout(() => {
    createFloatingHud();
    connectWebSocket();
  }, 1000);

})();
