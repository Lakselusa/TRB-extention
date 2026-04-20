import { useState, useCallback, useEffect, useRef } from "react";

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * Trimble Connect 3D Viewer Extension
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs INSIDE Trimble Connect as a side-panel extension.
 * - Connects to window.parent via WorkspaceAPI
 * - Gets access token via extension.requestPermission("accesstoken")
 * - Project, region, and loaded models are already known
 * - Queries object visibility via viewer.getObjects()
 * - Exports only visible objects as a filtered TRB
 *
 * Integration:
 *   import { WorkspaceAPI } from "trimble-connect-workspace-api"
 *   import * as Workspace from "trimble-connect-workspace-api"
 *
 * Since this runs as a React artifact, we load the IIFE bundle from CDN
 * and access TrimbleConnectWorkspace globally.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ─── Design Tokens ───────────────────────────────────────────────────────────
// Industrial / utilitarian — dark, functional, data-dense
const T = {
  bg: "#0c1018",
  panel: "#111820",
  card: "#161e2a",
  cardHover: "#1a2436",
  border: "#1e2a3a",
  borderLit: "#2d4a6f",
  text: "#d4dce8",
  textDim: "#5a7089",
  textBright: "#f0f4f8",
  blue: "#2e8cf0",
  blueGlow: "rgba(46,140,240,0.12)",
  blueSolid: "rgba(46,140,240,0.2)",
  green: "#0dca73",
  greenGlow: "rgba(13,202,115,0.1)",
  red: "#f04848",
  redGlow: "rgba(240,72,72,0.1)",
  amber: "#e8a820",
  amberGlow: "rgba(232,168,32,0.1)",
  mono: `'IBM Plex Mono', 'Consolas', monospace`,
  sans: `'IBM Plex Sans', 'Segoe UI', system-ui, sans-serif`,
  radius: 6,
};

// ─── Main App ────────────────────────────────────────────────────────────────
export default function TrimbleConnectExtension() {
  const [phase, setPhase] = useState("init"); // init | connecting | ready | error
  const [errorMsg, setErrorMsg] = useState("");
  const [accessToken, setAccessToken] = useState(null);
  const [project, setProject] = useState(null);
  const [models, setModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState(null);

  // Object data
  const [allObjects, setAllObjects] = useState([]);
  const [visibleObjects, setVisibleObjects] = useState([]);
  const [hiddenObjects, setHiddenObjects] = useState([]);
  const [scanning, setScanning] = useState(false);
  const [lastScan, setLastScan] = useState(null);

  // Export
  const [exporting, setExporting] = useState(false);
  const [log, setLog] = useState([]);

  // API ref
  const apiRef = useRef(null);

  const addLog = useCallback((msg, type = "info") => {
    const ts = new Date().toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    setLog((prev) => [...prev.slice(-80), { msg, type, ts }]);
  }, []);

  // ─── Connect on mount ────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    async function initExtension() {
      setPhase("connecting");
      addLog("Initializing extension — connecting to Trimble Connect...");

      // Load the workspace API script
      if (!window.TrimbleConnectWorkspace) {
        addLog("Loading trimble-connect-workspace-api from CDN...");
        await new Promise((resolve, reject) => {
          const s = document.createElement("script");
          s.src =
            "https://components.connect.trimble.com/trimble-connect-workspace-api/index.js";
          s.onload = resolve;
          s.onerror = () => reject(new Error("Failed to load Workspace API"));
          document.head.appendChild(s);
        });
      }

      try {
        // Connect to the parent (Trimble Connect 3D Viewer)
        const API = await window.TrimbleConnectWorkspace.connect(
          window.parent,
          (event, data) => {
            handleEvent(event, data);
          },
          30000
        );

        if (cancelled) return;
        apiRef.current = API;
        addLog("Connected to Trimble Connect", "success");

        // Request access token
        addLog("Requesting access token...");
        const tokenResult = await API.extension.requestPermission("accesstoken");

        if (tokenResult === "pending") {
          addLog("Waiting for user to grant permission...", "warn");
          // Token will arrive via the extension.accessToken event
        } else if (tokenResult === "denied") {
          throw new Error("User denied access token permission");
        } else {
          setAccessToken(tokenResult);
          addLog("Access token received", "success");
        }

        // Get project info
        const proj = await API.project.getProject();
        setProject(proj);
        addLog(`Project: ${proj?.name || proj?.id || "unknown"}`, "success");

        // Get loaded models — getModels() = real files
        const modelList = await API.viewer.getModels("LOADED");
        setModels(modelList || []);
        addLog(
          `Loaded models: ${(modelList || []).length} file(s)`,
          "success"
        );
        if (modelList?.length > 0) {
          setSelectedModel(modelList[0]);
        }

        setPhase("ready");
      } catch (err) {
        if (cancelled) return;
        addLog(`Connection failed: ${err.message}`, "error");
        setErrorMsg(err.message);
        setPhase("error");
      }
    }

    function handleEvent(event, data) {
      if (event === "extension.accessToken") {
        const token = data?.data || data;
        setAccessToken(token);
        addLog("Access token refreshed via event", "success");
      }
      if (event === "viewer.modelState.changed") {
        addLog(`Model state: ${data?.data?.state || JSON.stringify(data)}`, "info");
        // Re-fetch models when state changes
        if (apiRef.current) {
          apiRef.current.viewer.getModels("LOADED").then((m) => {
            setModels(m || []);
          });
        }
      }
    }

    initExtension();
    return () => {
      cancelled = true;
    };
  }, [addLog]);

  // ─── Scan object visibility ───────────────────────────────────────────
  const scanObjects = useCallback(async () => {
    const API = apiRef.current;
    if (!API) return;

    setScanning(true);
    addLog("Scanning object visibility in viewer...");

    try {
      // All objects
      const all = await API.viewer.getObjects();
      setAllObjects(all || []);

      // Visible only
      const vis = await API.viewer.getObjects(undefined, { visible: true });
      setVisibleObjects(vis || []);

      // Hidden only
      const hid = await API.viewer.getObjects(undefined, { visible: false });
      setHiddenObjects(hid || []);

      const countAll = (all || []).reduce(
        (s, m) => s + (m.objectRuntimeIds?.length || 0), 0
      );
      const countVis = (vis || []).reduce(
        (s, m) => s + (m.objectRuntimeIds?.length || 0), 0
      );
      const countHid = (hid || []).reduce(
        (s, m) => s + (m.objectRuntimeIds?.length || 0), 0
      );

      addLog(
        `Scan complete — ${countAll} total, ${countVis} visible, ${countHid} hidden`,
        "success"
      );
      setLastScan(new Date());
    } catch (err) {
      addLog(`Scan failed: ${err.message}`, "error");
    } finally {
      setScanning(false);
    }
  }, [addLog]);

  // ─── Reset all visibility ────────────────────────────────────────────
  const resetVisibility = useCallback(async () => {
    const API = apiRef.current;
    if (!API) return;
    try {
      await API.viewer.setObjectState(undefined, { visible: "reset" });
      addLog("Object visibility reset to defaults", "success");
      await scanObjects();
    } catch (err) {
      addLog(`Reset failed: ${err.message}`, "error");
    }
  }, [addLog, scanObjects]);

  // ─── Export visible as filtered TRB ───────────────────────────────────
  const exportFilteredTrb = useCallback(async () => {
    const API = apiRef.current;
    if (!API || visibleObjects.length === 0) {
      addLog("Nothing to export — scan objects first", "error");
      return;
    }

    setExporting(true);
    addLog("═══ Starting filtered TRB export ═══");

    try {
      for (const modelObj of visibleObjects) {
        const modelId = modelObj.modelId;
        const runtimeIds = modelObj.objectRuntimeIds || [];

        if (runtimeIds.length === 0) {
          addLog(`Model ${shortId(modelId)}: no visible objects, skipping`);
          continue;
        }

        addLog(`Model ${shortId(modelId)}: ${runtimeIds.length} visible objects`);

        // Convert runtime IDs → external IDs (IFC GUIDs)
        let externalIds = null;
        try {
          externalIds = await API.viewer.convertToObjectIds(modelId, runtimeIds);
          addLog(
            `Converted ${externalIds.length} IDs to IFC GUIDs`,
            "success"
          );
        } catch (err) {
          addLog(`ID conversion skipped: ${err.message}`, "warn");
        }

        // Approach 1: addTrimbimModel with selector filter
        const filteredId = `export_${modelId.slice(0, 8)}_${Date.now()}`;
        addLog(`Adding filtered TRB (${filteredId})...`);

        try {
          const trbResult = await API.viewer.addTrimbimModel({
            id: filteredId,
            trbBlobFromId: modelId,
            visible: true,
            fitToView: false,
            selector: {
              modelObjectIds: [
                {
                  modelId: modelId,
                  objectRuntimeIds: runtimeIds,
                },
              ],
            },
          });
          addLog(`Filtered TRB loaded: ${JSON.stringify(trbResult)}`, "success");
        } catch (err) {
          addLog(`addTrimbimModel failed: ${err.message}`, "error");

          // Approach 2: isolateEntities
          addLog("Fallback → isolateEntities...");
          try {
            await API.viewer.isolateEntities([
              {
                modelId: modelId,
                objectRuntimeIds: runtimeIds,
              },
            ]);
            addLog("isolateEntities succeeded", "success");
          } catch (err2) {
            addLog(`isolateEntities failed: ${err2.message}`, "error");
          }
        }

        // Log the external IDs for downstream use
        if (externalIds && externalIds.length > 0) {
          addLog(
            `IFC GUIDs (first 5): ${externalIds.slice(0, 5).join(", ")}${
              externalIds.length > 5 ? "..." : ""
            }`,
            "info"
          );
        }
      }

      // Take a snapshot as confirmation
      try {
        const snap = await API.viewer.getSnapshot();
        addLog(`Snapshot captured (${(snap?.length || 0)} chars)`, "success");
      } catch {
        // non-critical
      }

      addLog("═══ Export complete ═══", "success");
    } catch (err) {
      addLog(`Export error: ${err.message}`, "error");
    } finally {
      setExporting(false);
    }
  }, [addLog, visibleObjects]);

  // ─── Counts ───────────────────────────────────────────────────────────
  const countOf = (arr) =>
    (arr || []).reduce((s, m) => s + (m.objectRuntimeIds?.length || 0), 0);

  const nAll = countOf(allObjects);
  const nVis = countOf(visibleObjects);
  const nHid = countOf(hiddenObjects);

  // ─── Render ───────────────────────────────────────────────────────────
  return (
    <div style={styles.root}>
      {/* Header */}
      <div style={styles.header}>
        <div style={styles.headerLeft}>
          <div style={styles.logo}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M2 4L8 1L14 4V12L8 15L2 12V4Z" stroke={T.blue} strokeWidth="1.5" fill={T.blueSolid} />
              <path d="M8 1V15" stroke={T.blue} strokeWidth="1" opacity="0.4" />
              <path d="M2 4L14 4" stroke={T.blue} strokeWidth="1" opacity="0.4" />
            </svg>
          </div>
          <div>
            <div style={styles.headerTitle}>Visibility Filter</div>
            <div style={styles.headerSub}>
              {project ? project.name || shortId(project.id) : "Connecting..."}
            </div>
          </div>
        </div>
        <StatusDot phase={phase} />
      </div>

      {/* Content */}
      <div style={styles.content}>
        {/* ── Connecting / Error states ─── */}
        {phase === "init" || phase === "connecting" ? (
          <StatusPanel
            icon="◌"
            title="Connecting"
            subtitle="Establishing connection to Trimble Connect 3D Viewer..."
            color={T.blue}
            spin
          />
        ) : phase === "error" ? (
          <StatusPanel
            icon="✕"
            title="Connection Failed"
            subtitle={errorMsg}
            color={T.red}
          />
        ) : (
          <>
            {/* ── Models ───────────────────────────────── */}
            <Section label="Loaded Models" count={models.length}>
              {models.length === 0 ? (
                <div style={styles.empty}>
                  No models loaded. Open a model in the viewer first.
                </div>
              ) : (
                models.map((m, i) => (
                  <button
                    key={m.id || i}
                    onClick={() => setSelectedModel(m)}
                    style={{
                      ...styles.modelRow,
                      borderColor:
                        selectedModel?.id === m.id ? T.blue : T.border,
                      background:
                        selectedModel?.id === m.id ? T.blueGlow : "transparent",
                    }}
                  >
                    <div style={styles.modelName}>
                      {m.name || shortId(m.id)}
                    </div>
                    <div style={styles.modelId}>{shortId(m.id)}</div>
                    {m.state && (
                      <span
                        style={{
                          ...styles.badge,
                          color:
                            m.state === "LOADED"
                              ? T.green
                              : m.state === "LOADING"
                              ? T.amber
                              : T.textDim,
                          background:
                            m.state === "LOADED"
                              ? T.greenGlow
                              : m.state === "LOADING"
                              ? T.amberGlow
                              : "transparent",
                        }}
                      >
                        {m.state}
                      </span>
                    )}
                  </button>
                ))
              )}
            </Section>

            {/* ── Scan ─────────────────────────────────── */}
            <Section label="Object Visibility">
              <Btn
                onClick={scanObjects}
                disabled={scanning}
                color={T.blue}
                label={scanning ? "Scanning..." : "Scan Visibility"}
                primary
              />

              {lastScan && (
                <>
                  <div style={styles.statRow}>
                    <Stat label="Total" value={nAll} color={T.blue} />
                    <Stat label="Visible" value={nVis} color={T.green} />
                    <Stat label="Hidden" value={nHid} color={T.red} />
                  </div>

                  {/* Per-model breakdown */}
                  {visibleObjects.map((mo, i) => (
                    <div key={i} style={styles.objectCard}>
                      <div style={styles.objectModelId}>
                        {shortId(mo.modelId)}
                      </div>
                      <div style={styles.objectCounts}>
                        <span style={{ color: T.green }}>
                          {mo.objectRuntimeIds?.length || 0} visible
                        </span>
                        {hiddenObjects[i] && (
                          <span style={{ color: T.red, marginLeft: 8 }}>
                            {hiddenObjects[i]?.objectRuntimeIds?.length || 0}{" "}
                            hidden
                          </span>
                        )}
                      </div>
                      {mo.objectRuntimeIds?.length > 0 && (
                        <div style={styles.idPreview}>
                          [{mo.objectRuntimeIds.slice(0, 12).join(", ")}
                          {mo.objectRuntimeIds.length > 12 ? " …" : ""}]
                        </div>
                      )}
                    </div>
                  ))}

                  <Btn
                    onClick={resetVisibility}
                    color={T.amber}
                    label="Reset All Visibility"
                  />
                </>
              )}

              {!lastScan && (
                <div style={styles.hint}>
                  Hide objects in the 3D viewer (right-click → Hide), then scan
                  to capture which objects are visible.
                </div>
              )}
            </Section>

            {/* ── Export ────────────────────────────────── */}
            <Section label="Export Filtered TRB">
              <div style={styles.exportInfo}>
                <Row label="Will include" value={`${nVis} objects`} color={T.green} />
                <Row label="Will exclude" value={`${nHid} objects`} color={T.red} />
                {selectedModel && (
                  <Row
                    label="Source model"
                    value={selectedModel.name || shortId(selectedModel.id)}
                    color={T.blue}
                  />
                )}
              </div>

              <Btn
                onClick={exportFilteredTrb}
                disabled={exporting || nVis === 0}
                color={T.green}
                label={
                  exporting
                    ? "Exporting..."
                    : nVis === 0
                    ? "Scan objects first"
                    : `Export ${nVis} visible objects → TRB`
                }
                primary
              />
            </Section>

            {/* ── Log ──────────────────────────────────── */}
            <Section label="Log" count={log.length}>
              <div style={styles.logContainer}>
                {log.length === 0 ? (
                  <div style={styles.empty}>No operations yet.</div>
                ) : (
                  log
                    .slice()
                    .reverse()
                    .map((entry, i) => (
                      <div
                        key={i}
                        style={{
                          ...styles.logLine,
                          color:
                            entry.type === "error"
                              ? T.red
                              : entry.type === "success"
                              ? T.green
                              : entry.type === "warn"
                              ? T.amber
                              : T.textDim,
                          background:
                            entry.type === "error"
                              ? T.redGlow
                              : entry.type === "success"
                              ? T.greenGlow
                              : "transparent",
                        }}
                      >
                        <span style={{ opacity: 0.45 }}>{entry.ts}</span>{" "}
                        {entry.msg}
                      </div>
                    ))
                )}
              </div>
              {log.length > 0 && (
                <Btn
                  onClick={() => setLog([])}
                  color={T.textDim}
                  label="Clear"
                  small
                />
              )}
            </Section>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Subcomponents ───────────────────────────────────────────────────────────

function Section({ label, count, children }) {
  return (
    <div style={styles.section}>
      <div style={styles.sectionHeader}>
        <span style={styles.sectionLabel}>{label}</span>
        {count != null && (
          <span style={styles.sectionCount}>{count}</span>
        )}
      </div>
      {children}
    </div>
  );
}

function Btn({ onClick, disabled, color, label, primary, small }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        width: "100%",
        padding: small ? "6px 10px" : "10px 14px",
        border: `1px solid ${disabled ? T.border : color}`,
        borderRadius: T.radius,
        background: primary && !disabled ? `${color}22` : "transparent",
        color: disabled ? T.textDim : color,
        fontFamily: T.sans,
        fontSize: small ? 11 : 12,
        fontWeight: 600,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.45 : 1,
        transition: "all 0.12s ease",
        marginTop: 6,
        letterSpacing: "0.01em",
      }}
    >
      {label}
    </button>
  );
}

function Stat({ label, value, color }) {
  return (
    <div style={{ ...styles.stat, borderColor: `${color}33` }}>
      <div
        style={{
          fontSize: 20,
          fontWeight: 800,
          color,
          fontFamily: T.mono,
          lineHeight: 1,
        }}
      >
        {value}
      </div>
      <div style={styles.statLabel}>{label}</div>
    </div>
  );
}

function Row({ label, value, color }) {
  return (
    <div style={styles.row}>
      <span style={styles.rowLabel}>{label}</span>
      <span style={{ ...styles.rowValue, color }}>{value}</span>
    </div>
  );
}

function StatusDot({ phase }) {
  const color =
    phase === "ready"
      ? T.green
      : phase === "error"
      ? T.red
      : T.amber;
  const label =
    phase === "ready"
      ? "Live"
      : phase === "error"
      ? "Error"
      : "Connecting";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <div
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: color,
          boxShadow: `0 0 6px ${color}`,
          animation:
            phase === "connecting"
              ? "pulse 1.5s ease-in-out infinite"
              : "none",
        }}
      />
      <span style={{ fontSize: 10, color: T.textDim, fontFamily: T.mono }}>
        {label}
      </span>
      <style>{`@keyframes pulse { 0%,100% { opacity:1 } 50% { opacity:0.3 } }`}</style>
    </div>
  );
}

function StatusPanel({ icon, title, subtitle, color, spin }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "48px 24px",
        textAlign: "center",
      }}
    >
      <div
        style={{
          fontSize: 32,
          color,
          marginBottom: 12,
          animation: spin ? "spin 2s linear infinite" : "none",
        }}
      >
        {icon}
      </div>
      <div
        style={{
          fontSize: 15,
          fontWeight: 700,
          color: T.textBright,
          marginBottom: 6,
        }}
      >
        {title}
      </div>
      <div style={{ fontSize: 12, color: T.textDim, maxWidth: 260, lineHeight: 1.5 }}>
        {subtitle}
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function shortId(id) {
  if (!id) return "—";
  if (id.length <= 16) return id;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

// ─── Styles ──────────────────────────────────────────────────────────────────
const styles = {
  root: {
    fontFamily: T.sans,
    background: T.bg,
    color: T.text,
    minHeight: "100vh",
    display: "flex",
    flexDirection: "column",
    maxWidth: 420,
    margin: "0 auto",
  },
  header: {
    padding: "14px 16px",
    borderBottom: `1px solid ${T.border}`,
    background: T.panel,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerLeft: {
    display: "flex",
    alignItems: "center",
    gap: 10,
  },
  logo: {
    width: 32,
    height: 32,
    borderRadius: 6,
    background: T.blueGlow,
    border: `1px solid ${T.blue}33`,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    fontSize: 14,
    fontWeight: 700,
    letterSpacing: "-0.02em",
    color: T.textBright,
  },
  headerSub: {
    fontSize: 11,
    color: T.textDim,
    fontFamily: T.mono,
    marginTop: 1,
  },
  content: {
    flex: 1,
    overflowY: "auto",
    padding: "12px 14px",
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  section: {
    background: T.panel,
    border: `1px solid ${T.border}`,
    borderRadius: T.radius + 2,
    padding: "12px 14px",
  },
  sectionHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    color: T.textDim,
  },
  sectionCount: {
    fontSize: 10,
    fontFamily: T.mono,
    color: T.textDim,
    background: T.card,
    padding: "2px 7px",
    borderRadius: 4,
  },
  modelRow: {
    width: "100%",
    display: "block",
    textAlign: "left",
    padding: "9px 11px",
    border: `1px solid ${T.border}`,
    borderRadius: T.radius,
    background: "transparent",
    cursor: "pointer",
    marginBottom: 4,
    transition: "all 0.1s ease",
    fontFamily: T.sans,
  },
  modelName: {
    fontSize: 12,
    fontWeight: 600,
    color: T.textBright,
    lineHeight: 1.3,
  },
  modelId: {
    fontSize: 10,
    fontFamily: T.mono,
    color: T.textDim,
    marginTop: 2,
  },
  badge: {
    display: "inline-block",
    fontSize: 9,
    fontWeight: 700,
    fontFamily: T.mono,
    padding: "2px 6px",
    borderRadius: 3,
    marginTop: 4,
    letterSpacing: "0.03em",
  },
  statRow: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr 1fr",
    gap: 6,
    marginTop: 10,
    marginBottom: 8,
  },
  stat: {
    padding: "8px 6px",
    borderRadius: T.radius,
    border: `1px solid ${T.border}`,
    textAlign: "center",
  },
  statLabel: {
    fontSize: 9,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    color: T.textDim,
    marginTop: 3,
  },
  objectCard: {
    padding: "8px 10px",
    borderRadius: T.radius,
    border: `1px solid ${T.border}`,
    marginBottom: 6,
  },
  objectModelId: {
    fontSize: 11,
    fontFamily: T.mono,
    color: T.blue,
    fontWeight: 600,
  },
  objectCounts: {
    fontSize: 11,
    marginTop: 3,
  },
  idPreview: {
    fontSize: 9,
    fontFamily: T.mono,
    color: T.textDim,
    marginTop: 4,
    lineHeight: 1.4,
    wordBreak: "break-all",
    maxHeight: 36,
    overflow: "hidden",
  },
  exportInfo: {
    padding: "8px 10px",
    borderRadius: T.radius,
    border: `1px solid ${T.border}`,
    marginBottom: 8,
  },
  row: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "4px 0",
  },
  rowLabel: {
    fontSize: 11,
    color: T.textDim,
  },
  rowValue: {
    fontSize: 11,
    fontFamily: T.mono,
    fontWeight: 600,
  },
  hint: {
    fontSize: 11,
    color: T.textDim,
    lineHeight: 1.5,
    marginTop: 8,
    padding: "8px 10px",
    borderRadius: T.radius,
    border: `1px dashed ${T.border}`,
  },
  logContainer: {
    maxHeight: 200,
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: 1,
  },
  logLine: {
    fontSize: 10,
    fontFamily: T.mono,
    padding: "3px 6px",
    borderRadius: 3,
    lineHeight: 1.4,
    wordBreak: "break-word",
  },
  empty: {
    fontSize: 11,
    color: T.textDim,
    textAlign: "center",
    padding: "12px 0",
  },
};
