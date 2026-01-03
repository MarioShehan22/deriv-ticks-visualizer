import React, { useEffect, useMemo, useRef, useState } from "react";

const APP_ID = 39895;
const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}&l=EN&brand=deriv`;

const PING_EVERY_MS = 30000;

function getLastDigit(quote, pipSize = 2) {
    const s = Number(quote).toFixed(pipSize);
    const ch = s[s.length - 1];
    const d = Number(ch);
    return Number.isFinite(d) ? d : 0;
}

function argmax(arr) {
    let best = 0;
    for (let i = 1; i < arr.length; i++) if (arr[i] > arr[best]) best = i;
    return best;
}

export default function App() {
    // --- Connection refs (stable auto reconnect) ---
    const wsRef = useRef(null);
    const pingRef = useRef(null);
    const reconnectRef = useRef(null);
    const attemptRef = useRef(0);

    const shouldReconnectRef = useRef(true); // keep connection always
    const manualCloseRef = useRef(false);    // stop reconnect if user clicks Disconnect

    // --- Rolling window storage (FAST) ---
    const digitQueueRef = useRef([]); // stores only last N digits

    // --- UI state ---
    const [symbol, setSymbol] = useState("R_100");
    const [windowSize, setWindowSize] = useState(200);

    const [counts, setCounts] = useState(() => Array(10).fill(0));
    const [lastDigit, setLastDigit] = useState(null);

    // ✅ Unlimited “all-time ticks” counter (safe, no memory leak)
    const [totalAllTime, setTotalAllTime] = useState(0);

    const [status, setStatus] = useState("disconnected"); // connecting/connected/disconnected
    const [error, setError] = useState("");

    // ✅ Always correct rolling total (prevents 50% bug)
    const totalRolling = useMemo(() => counts.reduce((a, b) => a + b, 0), [counts]);

    // Rolling probabilities (fast)
    const percents = useMemo(() => {
        return counts.map((c) => (totalRolling > 0 ? (c / totalRolling) * 100 : 0));
    }, [counts, totalRolling]);

    const topDigit = useMemo(() => (totalRolling ? argmax(percents) : null), [percents, totalRolling]);
    const topPct = useMemo(() => (topDigit == null ? 0 : percents[topDigit]), [percents, topDigit]);

    function clearTimers() {
        if (pingRef.current) clearInterval(pingRef.current);
        if (reconnectRef.current) clearTimeout(reconnectRef.current);
        pingRef.current = null;
        reconnectRef.current = null;
    }

    function resetStats() {
        digitQueueRef.current = [];
        setCounts(Array(10).fill(0));
        setLastDigit(null);
        setError("");
    }

    // FAST update: only affects rolling window + all-time counter
    function pushDigit(d) {
        setLastDigit(d);
        setTotalAllTime((t) => t + 1); // unlimited counter

        setCounts((prev) => {
            const next = [...prev];
            next[d] += 1;

            digitQueueRef.current.push(d);

            // keep only last N digits (FAST and bounded memory)
            if (digitQueueRef.current.length > windowSize) {
                const removed = digitQueueRef.current.shift();
                next[removed] -= 1;
            }
            return next;
        });
    }

    function closeWS() {
        const ws = wsRef.current;
        if (!ws) return;

        manualCloseRef.current = true;
        clearTimers();

        try {
            if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) {
                ws.close(1000, "manual close");
            } else {
                ws.close();
            }
        } catch {}

        wsRef.current = null;
        setStatus("disconnected");
    }

    function scheduleReconnect() {
        if (!shouldReconnectRef.current) return;

        // exponential backoff: 1s, 2s, 4s, 8s... max 20s
        const delay = Math.min(20000, 1000 * Math.pow(2, attemptRef.current));
        attemptRef.current += 1;

        reconnectRef.current = setTimeout(() => {
            connectWS();
        }, delay);
    }

    function connectWS() {
        // Avoid double connections
        if (
            wsRef.current &&
            (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)
        ) {
            return;
        }

        manualCloseRef.current = false;
        setError("");
        setStatus("connecting");

        const ws = new WebSocket(WS_URL);
        wsRef.current = ws;

        ws.onopen = () => {
            if (ws !== wsRef.current) return;

            attemptRef.current = 0; // reset backoff on successful connect
            setStatus("connected");

            // subscribe ticks
            ws.send(JSON.stringify({ ticks: symbol, subscribe: 1 }));

            // keep alive ping
            clearTimers();
            pingRef.current = setInterval(() => {
                try {
                    if (wsRef.current?.readyState === WebSocket.OPEN) {
                        wsRef.current.send(JSON.stringify({ ping: 1 }));
                    }
                } catch {}
            }, PING_EVERY_MS);
        };

        ws.onmessage = (e) => {
            if (ws !== wsRef.current) return;

            let msg;
            try {
                msg = JSON.parse(e.data);
            } catch {
                return;
            }

            if (msg.error) {
                setError(msg.error.message || "API error");
                return;
            }

            if (msg.msg_type === "tick" && msg.tick) {
                const d = getLastDigit(msg.tick.quote, msg.tick.pip_size ?? 2);
                pushDigit(d);
            }
        };

        ws.onerror = () => {
            // browsers hide details; we handle reconnection in onclose
        };

        ws.onclose = (ev) => {
            if (ws !== wsRef.current) return;

            clearTimers();
            wsRef.current = null;
            setStatus("disconnected");

            // If user clicked Disconnect, do NOT reconnect
            if (manualCloseRef.current) return;

            if (ev.code !== 1000) {
                setError(`Socket closed (code ${ev.code}) — reconnecting…`);
            }
            scheduleReconnect();
        };
    }

    function startAlwaysOn() {
        shouldReconnectRef.current = true;
        manualCloseRef.current = false;
        connectWS();
    }

    function stopAlwaysOn() {
        shouldReconnectRef.current = false;
        closeWS();
    }

    // Always keep connected
    useEffect(() => {
        startAlwaysOn();
        return () => stopAlwaysOn();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Reconnect on symbol change
    useEffect(() => {
        if (!shouldReconnectRef.current) return;

        // restart connection cleanly
        closeWS();
        resetStats();
        startAlwaysOn();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [symbol]);

    // Keep rolling window consistent if windowSize changes
    useEffect(() => {
        // if queue is bigger than window, trim and fix counts
        const q = digitQueueRef.current;
        if (q.length <= windowSize) return;

        // recompute counts from last windowSize digits
        const last = q.slice(q.length - windowSize);
        digitQueueRef.current = last;

        const newCounts = Array(10).fill(0);
        for (const d of last) newCounts[d]++;

        setCounts(newCounts);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [windowSize]);

    return (
        <div style={{ fontFamily: "system-ui", padding: 16, maxWidth: 1100, margin: "0 auto" }}>
            <h2 style={{ margin: 0 }}>Deriv Last Digit (Fast Rolling + Unlimited Total)</h2>

            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "end", marginTop: 12 }}>
                <label style={ui.label}>
                    Symbol
                    <select value={symbol} onChange={(e) => setSymbol(e.target.value)} style={ui.select}>
                        <option value="R_100">R_100</option>
                        <option value="R_50">R_50</option>
                        <option value="R_25">R_25</option>
                        <option value="R_10">R_10</option>
                        <option value="1HZ100V">1HZ100V</option>
                        <option value="1HZ50V">1HZ50V</option>
                    </select>
                </label>

                <label style={ui.label}>
                    Rolling window (last N ticks)
                    <input
                        type="number"
                        min={20}
                        max={5000}
                        value={windowSize}
                        onChange={(e) => setWindowSize(Math.max(20, Math.min(5000, Number(e.target.value || 200))))}
                        style={ui.input}
                    />
                </label>

                <button onClick={startAlwaysOn} style={ui.btn} disabled={status === "connected" || status === "connecting"}>
                    Connect (Always)
                </button>
                <button onClick={stopAlwaysOn} style={ui.btn} disabled={status === "disconnected"}>
                    Disconnect
                </button>
                <button onClick={resetStats} style={ui.btn}>
                    Reset rolling stats
                </button>

                <div style={{ marginLeft: "auto", minWidth: 200 }}>
                    <div style={{ fontSize: 12, color: "#666" }}>Status</div>
                    <div style={{ fontWeight: 800 }}>{status}</div>
                </div>
            </div>

            {error ? (
                <div style={{ background: "#ffe8e8", padding: 10, borderRadius: 10, marginTop: 12 }}>
                    <b>Error:</b> {error}
                </div>
            ) : null}

            <div style={{ marginTop: 14, color: "#666", fontSize: 13 }}>
                ✅ All-time ticks (unlimited): <b>{totalAllTime}</b> &nbsp;|&nbsp;
                Rolling ticks used for %: <b>{totalRolling}</b> &nbsp;|&nbsp;
                Latest digit: <b>{lastDigit ?? "-"}</b>
                {topDigit != null ? (
                    <>
                        &nbsp;|&nbsp; Top digit: <b>{topDigit}</b> ({topPct.toFixed(1)}%)
                    </>
                ) : null}
            </div>

            {/* Digits */}
            <div style={ui.row}>
                {Array.from({ length: 10 }).map((_, d) => {
                    const pct = percents[d];
                    const isLast = lastDigit === d;
                    const isTop = topDigit === d;

                    return (
                        <div key={d} style={{ ...ui.item, ...(isLast ? ui.itemActive : null) }}>
                            <div style={{ ...ui.ring, background: `conic-gradient(#e53935 ${pct * 3.6}deg, #e6e6e6 0deg)` }}>
                                <div style={ui.innerCircle}>{d}</div>
                            </div>
                            <div style={ui.pct}>{pct.toFixed(1)}%</div>
                            <div style={{ height: 4, marginTop: 6 }}>{isTop ? <div style={ui.underline} /> : null}</div>
                        </div>
                    );
                })}
            </div>

            <div style={{ marginTop: 10, fontSize: 12, color: "#666" }}>
                Rolling stats stay fast because we only store last <b>{windowSize}</b> digits. All-time ticks is just a counter.
            </div>
        </div>
    );
}

const ui = {
    label: { display: "flex", flexDirection: "column", gap: 6, fontSize: 12 },
    row: {
        display: "grid",
        gridTemplateColumns: "repeat(10, minmax(0, 1fr))",
        gap: 10,
        marginTop: 14,
    },
    item: { textAlign: "center", padding: 8, borderRadius: 12 },
    itemActive: { background: "rgba(229,57,53,0.06)" },
    ring: {
        width: 54,
        height: 54,
        borderRadius: "50%",
        display: "grid",
        placeItems: "center",
        margin: "0 auto",
    },
    innerCircle: {
        width: 42,
        height: 42,
        borderRadius: "50%",
        background: "#0040ff",
        display: "grid",
        placeItems: "center",
        fontWeight: 900,
        border: "1px solid #eee",
    },
    pct: { marginTop: 6, fontSize: 12, color: "#555", fontWeight: 700 },
    underline: { width: 20, height: 4, borderRadius: 6, background: "#0eff00", margin: "0 auto" },
    btn: {
        padding: "10px 12px",
        borderRadius: 10,
        border: "1px solid #ddd",
        background: "#686868",
        cursor: "pointer",
    },
    select: { padding: 10, borderRadius: 10, border: "1px solid #ddd", minWidth: 140 },
    input: { padding: 10, borderRadius: 10, border: "1px solid #ddd", width: 220 },
};
