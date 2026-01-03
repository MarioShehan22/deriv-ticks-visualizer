import React, { useEffect, useMemo, useRef, useState } from "react";

const APP_ID = 21317;
const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}&l=EN&brand=deriv`;

const MAX_HISTORY_MINUTES = 120;   // keep last 120 minutes
const SHOW_LAST_MINUTES = 20;      // show last 20 minutes in UI
const HISTORY_PUBLISH_MS = 700;    // throttle UI updates
const PING_EVERY_MS = 30000;

function getLastDigit(quote, pipSize = 2) {
    const s = Number(quote).toFixed(pipSize);
    const ch = s[s.length - 1];
    const d = Number(ch);
    return Number.isFinite(d) ? d : 0;
}

function minuteKeyFromEpoch(epochSec) {
    return Math.floor(epochSec / 60) * 60;
}

function formatMinute(epochSec) {
    const d = new Date(epochSec * 1000);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
}

/* ---------------------------
   Chi-square p-value helpers
   (Numerical Recipes style)
---------------------------- */
function gammaln(xx) {
    const cof = [
        76.18009172947146,
        -86.50532032941677,
        24.01409824083091,
        -1.231739572450155,
        0.001208650973866179,
        -0.000005395239384953,
    ];
    let x = xx;
    let y = x;
    let tmp = x + 5.5;
    tmp -= (x + 0.5) * Math.log(tmp);
    let ser = 1.000000000190015;
    for (let j = 0; j < cof.length; j++) {
        y += 1;
        ser += cof[j] / y;
    }
    return -tmp + Math.log(2.5066282746310005 * ser / x);
}

function gammp(a, x) {
    // regularized lower incomplete gamma P(a, x)
    const ITMAX = 200;
    const EPS = 3e-7;

    if (x < 0 || a <= 0) return NaN;
    if (x === 0) return 0;

    if (x < a + 1) {
        // series
        let ap = a;
        let sum = 1 / a;
        let del = sum;
        for (let n = 1; n <= ITMAX; n++) {
            ap += 1;
            del *= x / ap;
            sum += del;
            if (Math.abs(del) < Math.abs(sum) * EPS) {
                return sum * Math.exp(-x + a * Math.log(x) - gammaln(a));
            }
        }
        return sum * Math.exp(-x + a * Math.log(x) - gammaln(a));
    } else {
        // continued fraction for Q, then P = 1 - Q
        return 1 - gammq(a, x);
    }
}

function gammq(a, x) {
    // regularized upper incomplete gamma Q(a, x)
    const ITMAX = 200;
    const EPS = 3e-7;
    const FPMIN = 1e-30;

    if (x < 0 || a <= 0) return NaN;

    let b = x + 1 - a;
    let c = 1 / FPMIN;
    let d = 1 / b;
    let h = d;

    for (let i = 1; i <= ITMAX; i++) {
        const an = -i * (i - a);
        b += 2;
        d = an * d + b;
        if (Math.abs(d) < FPMIN) d = FPMIN;
        c = b + an / c;
        if (Math.abs(c) < FPMIN) c = FPMIN;
        d = 1 / d;
        const del = d * c;
        h *= del;
        if (Math.abs(del - 1) < EPS) break;
    }

    return h * Math.exp(-x + a * Math.log(x) - gammaln(a));
}

function chiSquareTest(counts, total) {
    const k = counts.length; // 10
    const df = k - 1;
    if (!total || total <= 0) return { chi2: 0, df, p: 1 };

    const expected = total / k;
    // Need expected > 0 (true if total>0). Rule-of-thumb: expected >= 5 for reliable test.
    let chi2 = 0;
    for (let i = 0; i < k; i++) {
        const o = counts[i];
        chi2 += ((o - expected) * (o - expected)) / expected;
    }

    // For Chi-square(df), CDF = P(df/2, chi2/2)
    const cdf = gammp(df / 2, chi2 / 2);
    const p = 1 - cdf; // upper-tail p-value
    return { chi2, df, p };
}

function downloadText(filename, text, mime = "text/plain") {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

export default function App() {
    const wsRef = useRef(null);
    const pingRef = useRef(null);
    const manualCloseRef = useRef(false);

    const digitWindowRef = useRef([]);         // last N digits (rolling window)
    const minuteBinsRef = useRef(new Map());   // minuteKey -> { minute, counts[10], total }
    const lastPublishRef = useRef(0);

    const [symbol, setSymbol] = useState("R_100");
    const [windowSize, setWindowSize] = useState(200);

    const [counts, setCounts] = useState(() => Array(10).fill(0));
    const [lastDigit, setLastDigit] = useState(null);

    const [minuteHistory, setMinuteHistory] = useState([]); // newest first
    const [alpha, setAlpha] = useState(0.05);

    const [status, setStatus] = useState("disconnected"); // connecting/connected/disconnected/error
    const [error, setError] = useState("");

    const total = useMemo(() => counts.reduce((a, b) => a + b, 0), [counts]);

    // ---- Alerts config ----
    const [alertsEnabled, setAlertsEnabled] = useState(true);
    const [alertDigits, setAlertDigits] = useState([8, 9]);   // focus digits
    const [highThreshold, setHighThreshold] = useState(15);   // % (example 15%)
    const [pairThreshold, setPairThreshold] = useState(10);   // % (example 10%)
    const [cooldownSec, setCooldownSec] = useState(20);       // seconds

    // ---- Alerts output ----
    const [alertBanner, setAlertBanner] = useState(null); // { type, text, time }
    const [alertLog, setAlertLog] = useState([]);         // array of entries

    const lastAlertRef = useRef({ key: "", at: 0, active: false });
    const percents = useMemo(() => {
        return counts.map((c) => (total > 0 ? (c / total) * 100 : 0));
    }, [counts, total]);


    useEffect(() => {
        if (!alertsEnabled) return;
        if (!total || total < 20) return; // wait until some data

        const probs = counts.map((c) => (total > 0 ? (c / total) * 100 : 0));

        // Find top digit among 0..9
        let topDigit = 0;
        for (let i = 1; i < 10; i++) {
            if (probs[i] > probs[topDigit]) topDigit = i;
        }

        // We only care about 8 and 9 (or whatever is in alertDigits)
        if (alertDigits.length !== 2) return;

        const [d1, d2] = alertDigits; // default [8, 9]
        const isTopInPair = topDigit === d1 || topDigit === d2;

        if (!isTopInPair) {
            lastAlertRef.current.active = false;
            return;
        }

        const otherDigit = topDigit === d1 ? d2 : d1;

        const topPct = probs[topDigit];
        const otherPct = probs[otherDigit];

        // ✅ Combined AND condition:
        const ok = topPct >= highThreshold && otherPct >= pairThreshold;

        const now = Date.now();
        const cooldownMs = cooldownSec * 1000;

        const fire = (key, text) => {
            const prev = lastAlertRef.current;

            // prevent spam
            if (prev.key === key && prev.active && now - prev.at < cooldownMs) return;

            lastAlertRef.current = { key, at: now, active: true };

            const entry = {
                key,
                type: "COMBINED",
                text,
                time: new Date().toLocaleTimeString(),
            };

            setAlertBanner(entry);
            setAlertLog((prevLog) => [entry, ...prevLog].slice(0, 50));
        };

        if (ok) {
            fire(
                `COMBINED_${topDigit}_${otherDigit}`,
                `ALERT: TOP digit ${topDigit} = ${topPct.toFixed(1)}% (≥ ${highThreshold}%), and ${otherDigit} = ${otherPct.toFixed(1)}% (≥ ${pairThreshold}%) in last ${total} ticks`
            );
        } else {
            // condition not met → allow immediate next alert when it becomes true
            lastAlertRef.current.active = false;
        }
    }, [alertsEnabled, counts, total, cooldownSec, alertDigits, highThreshold, pairThreshold]);

    const chi = useMemo(() => chiSquareTest(counts, total), [counts, total]);
    const uniformDecision = useMemo(() => {
        // If p < alpha -> statistically different from uniform
        // If p >= alpha -> cannot reject uniform
        const okExpected = total / 10 >= 5; // rule of thumb
        return {
            okExpected,
            isUniform: chi.p >= alpha,
        };
    }, [chi.p, alpha, total]);

    function resetStats(newWindowSize = windowSize) {
        digitWindowRef.current = [];
        minuteBinsRef.current = new Map();
        setCounts(Array(10).fill(0));
        setLastDigit(null);
        setMinuteHistory([]);
        setWindowSize(newWindowSize);
    }

    function publishMinuteHistoryThrottled() {
        const now = Date.now();
        if (now - lastPublishRef.current < HISTORY_PUBLISH_MS) return;
        lastPublishRef.current = now;

        const arr = Array.from(minuteBinsRef.current.values())
            .map((b) => ({ minute: b.minute, total: b.total, counts: [...b.counts] }))
            .sort((a, b) => b.minute - a.minute);
        setMinuteHistory(arr);
    }

    function updateMinuteBin(epochSec, digit) {
        const mk = minuteKeyFromEpoch(epochSec);
        let bin = minuteBinsRef.current.get(mk);
        if (!bin) {
            bin = { minute: mk, total: 0, counts: Array(10).fill(0) };
            minuteBinsRef.current.set(mk, bin);
        }
        bin.total += 1;
        bin.counts[digit] += 1;

        // prune old minutes
        const cutoff = Math.floor(Date.now() / 1000) - MAX_HISTORY_MINUTES * 60;
        for (const key of minuteBinsRef.current.keys()) {
            if (key < cutoff) minuteBinsRef.current.delete(key);
        }

        publishMinuteHistoryThrottled();
    }

    function pushDigit(d, epochSec) {
        setCounts((prev) => {
            const next = [...prev];
            next[d] += 1;

            digitWindowRef.current.push(d);

            if (digitWindowRef.current.length > windowSize) {
                const removed = digitWindowRef.current.shift();
                next[removed] -= 1;
            }
            return next;
        });

        updateMinuteBin(epochSec, d);
    }

    function clearPing() {
        if (pingRef.current) {
            clearInterval(pingRef.current);
            pingRef.current = null;
        }
    }

    function connect() {
        // close previous if any
        disconnect();

        setError("");
        setStatus("connecting");
        manualCloseRef.current = false;

        const ws = new WebSocket(WS_URL);
        wsRef.current = ws;

        ws.onopen = () => {
            if (ws !== wsRef.current) return;
            setStatus("connected");
            ws.send(JSON.stringify({ ticks: symbol, subscribe: 1 }));

            // keep-alive ping
            clearPing();
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
                setStatus("error");
                setError(msg.error.message || "API error");
                return;
            }

            if (msg.msg_type === "tick" && msg.tick) {
                const epoch = msg.tick.epoch ?? Math.floor(Date.now() / 1000);
                const d = getLastDigit(msg.tick.quote, msg.tick.pip_size ?? 2);
                setLastDigit(d);
                pushDigit(d, epoch);
            }
        };

        ws.onerror = () => {
            if (ws !== wsRef.current) return;
            if (manualCloseRef.current) return;
            setStatus("error");
            setError("WebSocket error (blocked / network / closed early)");
        };

        ws.onclose = (ev) => {
            if (ws !== wsRef.current) return;
            clearPing();
            if (!manualCloseRef.current) {
                // useful debug
                console.log("WS close:", ev.code, ev.reason);
            }
            setStatus("disconnected");
        };
    }

    function disconnect() {
        const ws = wsRef.current;
        if (!ws) return;

        manualCloseRef.current = true;
        clearPing();

        if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) {
            try {
                ws.close(1000, "manual close");
            } catch {}
        }

        wsRef.current = null;
        setStatus("disconnected");
    }

    function onChangeSymbol(newSymbol) {
        setSymbol(newSymbol);
        resetStats(windowSize);
        // if connected, reconnect
        if (wsRef.current) connect();
    }

    function downloadHistoryCSV() {
        const rows = [];
        const header = [
            "minute",
            "total",
            ...Array.from({ length: 10 }, (_, i) => `d${i}_count`),
            ...Array.from({ length: 10 }, (_, i) => `d${i}_pct`),
        ];
        rows.push(header.join(","));

        // oldest -> newest in file
        const sorted = [...minuteHistory].sort((a, b) => a.minute - b.minute);

        for (const r of sorted) {
            const pcts = r.counts.map((c) => (r.total ? (c / r.total) * 100 : 0));
            rows.push([
                formatMinute(r.minute),
                r.total,
                ...r.counts,
                ...pcts.map((p) => p.toFixed(2)),
            ].join(","));
        }

        downloadText(
            `deriv_last_digit_${symbol}_minute_history.csv`,
            rows.join("\n"),
            "text/csv"
        );
    }

    function downloadSnapshotJSON() {
        const snapshot = {
            symbol,
            windowSize,
            rollingCounts: counts,
            rollingTotal: total,
            chiSquare: chi,
            alpha,
            minuteHistory,
            createdAt: new Date().toISOString(),
        };
        downloadText(
            `deriv_last_digit_${symbol}_snapshot.json`,
            JSON.stringify(snapshot, null, 2),
            "application/json"
        );
    }

    // Auto-connect once (if StrictMode gives trouble, comment this out and use button only)
    useEffect(() => {
        connect();
        return () => disconnect();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <div style={{ fontFamily: "system-ui", padding: 16, maxWidth: 1200, margin: "0 auto",display:"flex",flexDirection:"column",alignItems: "center",justifyContent: "center" }}>
            {/* ALERT BANNER */}
            {alertBanner ? (
                <div style={{
                    marginTop: 12,
                    padding: 12,
                    borderRadius: 12,
                    border: "1px solid #eee",
                    background: alertBanner.type === "HIGH" ? "rgba(229,57,53,0.10)" : "rgba(21,101,192,0.10)"
                }}>
                    <b>{alertBanner.type === "HIGH" ? "High% Alert" : "Pair Alert"}</b>
                    <div style={{ marginTop: 4 }}>{alertBanner.text}</div>
                    <div style={{ fontSize: 12, color: "#666", marginTop: 4 }}>Time: {alertBanner.time}</div>
                </div>
            ) : null}

            {/* ALERT SETTINGS */}
            <div style={{ marginTop: 12, padding: 12, border: "1px solid #eee", borderRadius: 12 }}>
                <div style={{ fontWeight: 800, marginBottom: 8 }}>Alerts</div>

                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <input type="checkbox" checked={alertsEnabled} onChange={(e) => setAlertsEnabled(e.target.checked)} />
                        Enable alerts
                    </label>

                    <label style={{ fontSize: 12 }}>
                        High threshold (%)
                        <input
                            type="number"
                            value={highThreshold}
                            min={1}
                            max={99}
                            onChange={(e) => setHighThreshold(Number(e.target.value))}
                            style={{ ...ui.input, width: 120, marginLeft: 8 }}
                        />
                    </label>

                    <label style={{ fontSize: 12 }}>
                        Pair threshold (%)
                        <input
                            type="number"
                            value={pairThreshold}
                            min={1}
                            max={99}
                            onChange={(e) => setPairThreshold(Number(e.target.value))}
                            style={{ ...ui.input, width: 120, marginLeft: 8 }}
                        />
                    </label>

                    <label style={{ fontSize: 12 }}>
                        Cooldown (sec)
                        <input
                            type="number"
                            value={cooldownSec}
                            min={5}
                            max={300}
                            onChange={(e) => setCooldownSec(Number(e.target.value))}
                            style={{ ...ui.input, width: 120, marginLeft: 8 }}
                        />
                    </label>

                    <button onClick={() => { setAlertBanner(null); setAlertLog([]); }} style={ui.btn}>
                        Clear alerts
                    </button>
                </div>

                {/* ALERT LOG */}
                <div style={{ marginTop: 10 }}>
                    <div style={{ fontWeight: 700, marginBottom: 6 }}>Alert log (latest first)</div>
                    {alertLog.length === 0 ? (
                        <div style={{ color: "#666", fontSize: 12 }}>No alerts yet…</div>
                    ) : (
                        <div style={{ maxHeight: 180, overflow: "auto", border: "1px solid #f0f0f0", borderRadius: 10 }}>
                            {alertLog.map((a, idx) => (
                                <div key={idx} style={{ padding: 10, borderBottom: "1px solid #f5f5f5", fontSize: 12 }}>
                                    <b>{a.time}</b> • <b>{a.type}</b> • {a.text}
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            <h2 style={{ margin: 0 }}>Last Digit Probability (Deriv)</h2>

            <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginTop: 12, justifyContent: "center" }}>
                <label style={{ display: "flex", flexDirection: "column", fontSize: 12 }}>
                    Symbol
                    <select value={symbol} onChange={(e) => onChangeSymbol(e.target.value)} style={ui.select}>
                        <option value="R_100">R_100</option>
                        <option value="R_50">R_50</option>
                        <option value="R_25">R_25</option>
                        <option value="R_10">R_10</option>
                    </select>
                </label>

                <label style={{ display: "flex", flexDirection: "column", fontSize: 12 }}>
                    Window (last N ticks)
                    <input
                        type="number"
                        value={windowSize}
                        onChange={(e) => {
                            const n = Math.max(20, Math.min(5000, Number(e.target.value || 100)));
                            resetStats(n);
                        }}
                        style={ui.input}
                    />
                </label>

                <label style={{ display: "flex", flexDirection: "column", fontSize: 12 }}>
                    α (significance)
                    <select value={alpha} onChange={(e) => setAlpha(Number(e.target.value))} style={ui.select}>
                        <option value={0.1}>0.10</option>
                        <option value={0.05}>0.05</option>
                        <option value={0.01}>0.01</option>
                    </select>
                </label>

                <button onClick={connect} disabled={status === "connected" || status === "connecting"} style={ui.btn}>
                    Connect
                </button>
                <button onClick={disconnect} style={ui.btn}>
                    Disconnect
                </button>
                <button onClick={() => resetStats(windowSize)} style={ui.btn}>
                    Reset
                </button>

                <button onClick={downloadHistoryCSV} disabled={minuteHistory.length === 0} style={ui.btn}>
                    Download CSV
                </button>
                <button onClick={downloadSnapshotJSON} style={ui.btn}>
                    Download JSON
                </button>

                <div style={{ marginLeft: "auto" }}>
                    <div style={{ fontSize: 12, color: "#666" }}>Status</div>
                    <div style={{ fontWeight: 700 }}>{status}</div>
                </div>
            </div>

            {error ? (
                <div style={{ background: "#ffe8e8", padding: 10, borderRadius: 10, marginTop: 12 }}>
                    <b>Error:</b> {error}
                </div>
            ) : null}

            <div style={{ marginTop: 14, color: "#666", fontSize: 13 }}>
                Total ticks counted (rolling window): <b>{total}</b> • Latest digit: <b>{lastDigit ?? "-"}</b>
            </div>

            {/* DIGIT PROBABILITY ROW */}
            <div style={ui.row}>
                {Array.from({ length: 10 }).map((_, d) => {
                    const pct = percents[d];
                    const active = lastDigit === d;

                    return (
                        <div key={d} style={{ ...ui.item, ...(active ? ui.itemActive : null) }}>
                            <div
                                style={{
                                    ...ui.ring,
                                    background: `conic-gradient(#e53935 ${pct * 3.6}deg, #e6e6e6 0deg)`,
                                }}
                            >
                                <div style={ui.innerCircle}>{d}</div>
                            </div>
                            <div style={ui.pct}>{pct.toFixed(1)}%</div>
                            <div style={{ height: 4, marginTop: 6 }}>{active ? <div style={ui.underline} /> : null}</div>
                        </div>
                    );
                })}
            </div>

            {/* CHI-SQUARE SECTION */}
            <div style={{ marginTop: 14, padding: 12, border: "1px solid #eee", borderRadius: 12 }}>
                <div style={{ fontWeight: 800, marginBottom: 6 }}>Chi-square uniformity test</div>
                <div style={{ fontSize: 13, color: "#444", lineHeight: 1.5 }}>
                    χ² = <b>{chi.chi2.toFixed(3)}</b>, df = <b>{chi.df}</b>, p-value = <b>{chi.p.toFixed(4)}</b>
                    <br />
                    Decision (α={alpha}):{" "}
                    <b style={{ color: uniformDecision.isUniform ? "#2e7d32" : "#c62828" }}>
                        {uniformDecision.isUniform ? "Cannot reject uniform (looks ~uniform)" : "Reject uniform (not uniform)"}
                    </b>
                    {!uniformDecision.okExpected ? (
                        <div style={{ marginTop: 6, fontSize: 12, color: "#a15c00" }}>
                            Note: Expected count per digit is &lt; 5 (N/10 &lt; 5). Chi-square is less reliable with very small samples.
                        </div>
                    ) : null}
                </div>
            </div>

            {/* PER-MINUTE HISTORY TABLE */}
            <div style={{ marginTop: 14, padding: 12, border: "1px solid #eee", borderRadius: 12 }}>
                <div style={{ fontWeight: 800, marginBottom: 8 }}>
                    Per-minute distribution (last {SHOW_LAST_MINUTES} minutes)
                </div>

                {minuteHistory.length === 0 ? (
                    <div style={{ color: "#666" }}>No minute history yet…</div>
                ) : (
                    <div style={{ overflowX: "auto" }}>
                        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
                            <thead>
                            <tr>
                                <th style={th}>Minute</th>
                                <th style={th}>N</th>
                                {Array.from({ length: 10 }, (_, d) => (
                                    <th key={d} style={th}>{d}</th>
                                ))}
                            </tr>
                            </thead>
                            <tbody>
                            {minuteHistory.slice(0, SHOW_LAST_MINUTES).map((row) => {
                                const maxCount = Math.max(...row.counts);
                                return (
                                    <tr key={row.minute}>
                                        <td style={td}>{formatMinute(row.minute)}</td>
                                        <td style={tdCenter}><b>{row.total}</b></td>
                                        {row.counts.map((c, d) => {
                                            const pct = row.total ? (c / row.total) * 100 : 0;
                                            const isMax = c === maxCount && row.total > 0;
                                            return (
                                                <td key={d} style={{ ...tdCenter, background: isMax ? "rgba(229,57,53,0.08)" : "transparent" }}>
                                                    <div style={{ fontWeight: 700 }}>{pct.toFixed(1)}%</div>
                                                    <div style={{ color: "#666" }}>({c})</div>
                                                </td>
                                            );
                                        })}
                                    </tr>
                                );
                            })}
                            </tbody>
                        </table>
                    </div>
                )}

                <div style={{ marginTop: 8, fontSize: 12, color: "#666" }}>
                    Each cell shows <b>%</b> and <b>(count)</b> for that minute. Highest digit in each minute is lightly highlighted.
                </div>
            </div>
        </div>
    );
}

const ui = {
    row: {
        display: "grid",
        gridTemplateColumns: "repeat(10, minmax(0, 1fr))",
        gap: 10,
        marginTop: 14,
    },
    item: {
        textAlign: "center",
        padding: 8,
        borderRadius: 12,
    },
    itemActive: {
        background: "rgba(229,57,53,0.06)",
    },
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
        fontWeight: 800,
        border: "1px solid #eee",
    },
    pct: {
        marginTop: 6,
        fontSize: 12,
        color: "#555",
        fontWeight: 600,
    },
    underline: {
        width: 20,
        height: 4,
        borderRadius: 6,
        background: "#e53935",
        margin: "0 auto",
    },
    btn: {
        padding: "10px 12px",
        borderRadius: 10,
        border: "1px solid #ddd",
        background: "#4444ec",
        cursor: "pointer",
    },
    select: {
        padding: 10,
        borderRadius: 10,
        border: "1px solid #ddd",
        minWidth: 120,
    },
    input: {
        padding: 10,
        borderRadius: 10,
        border: "1px solid #ddd",
        width: 180,
    },
};

const th = {
    textAlign: "center",
    padding: "8px 6px",
    borderBottom: "1px solid #eee",
    position: "sticky",
    top: 0,
    background: "#fff",
};

const td = {
    textAlign: "left",
    padding: "8px 6px",
    borderBottom: "1px solid #f2f2f2",
    whiteSpace: "nowrap",
};

const tdCenter = {
    textAlign: "center",
    padding: "8px 6px",
    borderBottom: "1px solid #f2f2f2",
    whiteSpace: "nowrap",
};
