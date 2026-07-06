import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import {
  ACTIVITY_THRESHOLD_DAYS,
  calculateDaysSinceLastActivity,
  getActivityColor,
  shouldPulseMarker,
} from "./activity.js";
import { normalizeRecordKey, parseSalesforceCsv } from "./csv.js";
import { formatAddress, geocodeAddress } from "./geocoding.js";

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN || "";
const INITIAL_CENTER = [-98.5795, 39.8283];
const INITIAL_ZOOM = 3;
const POINT_SOURCE_ID = "routeflow-address-points";
const DENSITY_SOURCE_ID = "routeflow-density-clusters";
const DENSITY_HALO_LAYER_ID = "routeflow-density-halos";
const DENSITY_BUBBLE_LAYER_ID = "routeflow-density-bubbles";
const PULSE_LAYER_ID = "routeflow-overdue-pulse";
const DOT_LAYER_ID = "routeflow-dots";
const UNKNOWN_ACTIVITY_COLOR = "#6b7280";
const ROUTEFLOW_API_URL = import.meta.env.VITE_ROUTEFLOW_API_URL || "http://localhost:5174";

mapboxgl.accessToken = MAPBOX_TOKEN;

export default function App() {
  const fileInputRef = useRef(null);
  const [locations, setLocations] = useState([]);
  const [status, setStatus] = useState("Drop a Salesforce CSV to map addresses.");
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState("");
  const [salesforceStatus, setSalesforceStatus] = useState({ connected: false, loading: true });
  const [isRefreshingSalesforce, setIsRefreshingSalesforce] = useState(false);

  const markerData = useMemo(
    () =>
      locations.map((location) => {
        const daysSinceLastActivity = calculateDaysSinceLastActivity(
          location.createdDate,
          location.lastActivity,
        );

        return {
          ...location,
          addressLabel: formatAddress(location),
          daysSinceLastActivity,
          activityColor: getActivityColor(daysSinceLastActivity),
          shouldPulse: shouldPulseMarker(daysSinceLastActivity),
        };
      }),
    [locations],
  );

  const importCsvFile = useCallback(async (file, sourceLabel = file?.name || "CSV") => {
    setError("");
    setStatus(`Parsing ${sourceLabel}...`);

    try {
      const records = await parseSalesforceCsv(file);
      const geocoded = await Promise.all(
        records.map(async (record, index) => {
          const coordinates = await geocodeAddress(record, index);
          return coordinates ? { id: normalizeRecordKey(record), ...record, ...coordinates } : null;
        }),
      );

      const nextLocations = geocoded.filter(Boolean);
      setLocations(nextLocations);
      setStatus(
        nextLocations.length
          ? `Mapped ${nextLocations.length} address${nextLocations.length === 1 ? "" : "es"} from ${sourceLabel}.`
          : "No usable addresses were found in that CSV.",
      );
    } catch (parseError) {
      setLocations([]);
      setError(parseError.message || "Unable to parse that CSV.");
      setStatus("Upload failed.");
    }
  }, []);

  const handleFiles = useCallback(
    async (files) => {
      const file = files?.[0];

      if (!file) {
        return;
      }

      await importCsvFile(file, file.name);
    },
    [importCsvFile],
  );

  const refreshSalesforceStatus = useCallback(async () => {
    try {
      const response = await fetch(`${ROUTEFLOW_API_URL}/api/salesforce/status`);
      const nextStatus = await response.json();
      setSalesforceStatus({ connected: Boolean(nextStatus.connected), loading: false });
    } catch {
      setSalesforceStatus({ connected: false, loading: false });
    }
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const salesforceError = params.get("salesforceError");
    const salesforceMessage = params.get("salesforce");

    if (salesforceError) {
      setError(salesforceError);
    } else if (salesforceMessage) {
      setStatus(salesforceMessage);
    }

    if (salesforceError || salesforceMessage) {
      window.history.replaceState({}, "", window.location.pathname);
    }

    refreshSalesforceStatus();
  }, [refreshSalesforceStatus]);

  const connectSalesforce = () => {
    window.location.href = `${ROUTEFLOW_API_URL}/api/salesforce/login`;
  };

  const disconnectSalesforce = async () => {
    setError("");

    try {
      await fetch(`${ROUTEFLOW_API_URL}/api/salesforce/logout`, { method: "POST" });
      setSalesforceStatus({ connected: false, loading: false });
      setStatus("Salesforce disconnected.");
    } catch {
      setError("Unable to disconnect Salesforce. Check that the local RouteFlow server is running.");
    }
  };

  const refreshFromSalesforce = async () => {
    setError("");
    setIsRefreshingSalesforce(true);
    setStatus("Refreshing Salesforce report...");

    try {
      const response = await fetch(`${ROUTEFLOW_API_URL}/api/salesforce/refresh-report`, {
        method: "POST",
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(payload.error || "Salesforce refresh failed.");
      }

      const csvFile = new File([payload.csv], "salesforce-report.csv", { type: "text/csv" });
      await importCsvFile(csvFile, payload.reportName || "Salesforce report");
      await refreshSalesforceStatus();
    } catch (refreshError) {
      setError(refreshError.message || "Salesforce refresh failed.");
      setStatus("Salesforce refresh failed.");
    } finally {
      setIsRefreshingSalesforce(false);
    }
  };

  return (
    <main className="app-shell">
      <section className="control-panel">
        <div>
          <p className="eyebrow">Salesforce CSV Mapper</p>
          <h1>Map company addresses from a CSV export.</h1>
        </div>

        <div
          className={`drop-zone${isDragging ? " is-dragging" : ""}`}
          onDragEnter={(event) => {
            event.preventDefault();
            setIsDragging(true);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={(event) => {
            event.preventDefault();
            setIsDragging(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            setIsDragging(false);
            handleFiles(event.dataTransfer.files);
          }}
          role="button"
          tabIndex={0}
          onClick={() => fileInputRef.current?.click()}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              fileInputRef.current?.click();
            }
          }}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            onChange={(event) => {
              handleFiles(event.target.files);
              event.target.value = "";
            }}
          />
          <strong>Drop CSV here</strong>
          <span>Required columns: Company, Street, City, State, Postal Code</span>
        </div>

        <p className="status">{status}</p>
        {error ? <p className="error">{error}</p> : null}
        {!MAPBOX_TOKEN ? (
          <p className="token-warning">
            Add <code>VITE_MAPBOX_ACCESS_TOKEN</code> to a local <code>.env</code> file to load Mapbox tiles.
          </p>
        ) : null}

        <SalesforceControls
          connected={salesforceStatus.connected}
          loading={salesforceStatus.loading}
          refreshing={isRefreshingSalesforce}
          onConnect={connectSalesforce}
          onDisconnect={disconnectSalesforce}
          onRefresh={refreshFromSalesforce}
        />

        <AddressList locations={locations} />
      </section>

      <MapView markers={markerData} />
    </main>
  );
}

function SalesforceControls({ connected, loading, refreshing, onConnect, onDisconnect, onRefresh }) {
  return (
    <section className="salesforce-controls" aria-label="Salesforce report controls">
      <div>
        <strong>Salesforce report</strong>
        <span>
          {loading
            ? "Checking connection..."
            : connected
              ? "Connected locally"
              : "Connect to refresh RouteFlow from a saved Salesforce report."}
        </span>
      </div>
      <div className="salesforce-actions">
        {connected ? (
          <>
            <button type="button" onClick={onRefresh} disabled={refreshing}>
              {refreshing ? "Refreshing..." : "Refresh from Salesforce"}
            </button>
            <button type="button" className="secondary-button" onClick={onDisconnect} disabled={refreshing}>
              Disconnect
            </button>
          </>
        ) : (
          <button type="button" onClick={onConnect} disabled={loading}>
            Connect Salesforce
          </button>
        )}
      </div>
    </section>
  );
}

function AddressList({ locations }) {
  if (!locations.length) {
    return <p className="empty-state">Uploaded addresses will appear here after parsing.</p>;
  }

  return (
    <ol className="address-list">
      {locations.map((location) => (
        <li key={location.id}>
          <strong>{location.companyName || "Unnamed company"}</strong>
          <span>{formatAddress(location)}</span>
          {location.isPlaceholder ? <em>Placeholder coordinates</em> : null}
        </li>
      ))}
    </ol>
  );
}

function MapView({ markers }) {
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const popupRef = useRef(null);
  const pulseFrameRef = useRef(null);
  const [isMapLoaded, setIsMapLoaded] = useState(false);

  const setMapContainer = useCallback((node) => {
    mapContainerRef.current = node;

    if (!node || mapRef.current || !MAPBOX_TOKEN) {
      return;
    }

    mapRef.current = new mapboxgl.Map({
      container: node,
      style: "mapbox://styles/mapbox/satellite-streets-v12",
      center: INITIAL_CENTER,
      zoom: INITIAL_ZOOM,
    });

    mapRef.current.addControl(new mapboxgl.NavigationControl(), "top-right");
    mapRef.current.on("load", () => setIsMapLoaded(true));
  }, []);

  useEffect(() => {
    const map = mapRef.current;

    if (!map || !isMapLoaded) {
      return;
    }

    ensureAddressLayers(map);
    const featureCollection = createFeatureCollection(markers);
    map.getSource(POINT_SOURCE_ID).setData(featureCollection);
    map.getSource(DENSITY_SOURCE_ID).setData(featureCollection);

    if (markers.length === 1) {
      map.flyTo({ center: [markers[0].longitude, markers[0].latitude], zoom: 8 });
    }

    if (markers.length > 1) {
      const bounds = markers.reduce(
        (nextBounds, marker) => nextBounds.extend([marker.longitude, marker.latitude]),
        new mapboxgl.LngLatBounds(
          [markers[0].longitude, markers[0].latitude],
          [markers[0].longitude, markers[0].latitude],
        ),
      );

      map.fitBounds(bounds, { padding: 72, maxZoom: 8 });
    }
  }, [isMapLoaded, markers]);

  useEffect(() => {
    const map = mapRef.current;

    if (!map || !isMapLoaded) {
      return undefined;
    }

    const handleDotClick = (event) => {
      const feature = event.features?.[0];

      if (!feature) {
        return;
      }

      popupRef.current?.remove();
      popupRef.current = new mapboxgl.Popup({ offset: 14 })
        .setLngLat(feature.geometry.coordinates)
        .setDOMContent(createPopupContent(feature.properties))
        .addTo(map);
    };

    const setPointerCursor = () => {
      map.getCanvas().style.cursor = "pointer";
    };
    const clearPointerCursor = () => {
      map.getCanvas().style.cursor = "";
    };

    map.on("click", DOT_LAYER_ID, handleDotClick);
    map.on("mouseenter", DOT_LAYER_ID, setPointerCursor);
    map.on("mouseleave", DOT_LAYER_ID, clearPointerCursor);

    return () => {
      map.off("click", DOT_LAYER_ID, handleDotClick);
      map.off("mouseenter", DOT_LAYER_ID, setPointerCursor);
      map.off("mouseleave", DOT_LAYER_ID, clearPointerCursor);
    };
  }, [isMapLoaded]);

  useEffect(() => {
    const map = mapRef.current;

    if (!map || !isMapLoaded) {
      return undefined;
    }

    const animatePulse = () => {
      if (map.getLayer(PULSE_LAYER_ID)) {
        const progress = (performance.now() % 2400) / 2400;
        map.setPaintProperty(PULSE_LAYER_ID, "circle-radius", 7 + progress * 9);
        map.setPaintProperty(PULSE_LAYER_ID, "circle-opacity", Math.max(0, 0.28 * (1 - progress)));
      }

      pulseFrameRef.current = requestAnimationFrame(animatePulse);
    };

    pulseFrameRef.current = requestAnimationFrame(animatePulse);

    return () => {
      if (pulseFrameRef.current) {
        cancelAnimationFrame(pulseFrameRef.current);
      }
    };
  }, [isMapLoaded]);

  if (!MAPBOX_TOKEN) {
    return (
      <section className="map-fallback">
        <div>
          <h2>Mapbox token needed</h2>
          <p>Create a <code>.env</code> file with <code>VITE_MAPBOX_ACCESS_TOKEN=your_token</code>.</p>
        </div>
      </section>
    );
  }

  return <section ref={setMapContainer} className="map-view" aria-label="Mapped Salesforce addresses" />;
}

function ensureAddressLayers(map) {
  if (!map.getSource(POINT_SOURCE_ID)) {
    map.addSource(POINT_SOURCE_ID, {
      type: "geojson",
      data: createFeatureCollection([]),
    });
  }

  if (!map.getSource(DENSITY_SOURCE_ID)) {
    map.addSource(DENSITY_SOURCE_ID, {
      type: "geojson",
      data: createFeatureCollection([]),
      cluster: true,
      clusterRadius: 44,
      clusterMaxZoom: 13,
      clusterProperties: {
        activityAgeSum: [
          "+",
          ["case", [">=", ["get", "daysSinceLastActivity"], 0], ["get", "daysSinceLastActivity"], 0],
        ],
        activityAgeCount: ["+", ["case", [">=", ["get", "daysSinceLastActivity"], 0], 1, 0]],
      },
    });
  }

  if (!map.getLayer(DENSITY_HALO_LAYER_ID)) {
    map.addLayer({
      id: DENSITY_HALO_LAYER_ID,
      type: "circle",
      source: DENSITY_SOURCE_ID,
      filter: ["has", "point_count"],
      paint: {
        "circle-color": getClusterColorExpression(),
        "circle-radius": ["step", ["get", "point_count"], 28, 10, 40, 30, 54, 75, 70],
        "circle-blur": 0.55,
        "circle-opacity": 0.28,
      },
    });
  }

  if (!map.getLayer(DENSITY_BUBBLE_LAYER_ID)) {
    map.addLayer({
      id: DENSITY_BUBBLE_LAYER_ID,
      type: "circle",
      source: DENSITY_SOURCE_ID,
      filter: ["has", "point_count"],
      paint: {
        "circle-color": getClusterColorExpression(),
        "circle-radius": ["step", ["get", "point_count"], 22, 10, 31, 30, 42, 75, 54],
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 1,
        "circle-opacity": 0.38,
        "circle-stroke-opacity": 0.35,
      },
    });
  }

  if (!map.getLayer(PULSE_LAYER_ID)) {
    map.addLayer({
      id: PULSE_LAYER_ID,
      type: "circle",
      source: POINT_SOURCE_ID,
      filter: ["==", ["get", "shouldPulse"], true],
      paint: {
        "circle-color": ["coalesce", ["get", "activityColor"], UNKNOWN_ACTIVITY_COLOR],
        "circle-radius": 7,
        "circle-opacity": 0.18,
      },
    });
  }

  if (!map.getLayer(DOT_LAYER_ID)) {
    map.addLayer({
      id: DOT_LAYER_ID,
      type: "circle",
      source: POINT_SOURCE_ID,
      paint: {
        "circle-color": ["coalesce", ["get", "activityColor"], UNKNOWN_ACTIVITY_COLOR],
        "circle-radius": 6.5,
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 1.5,
        "circle-opacity": 0.96,
        "circle-stroke-opacity": 1,
      },
    });
  }
}

function createFeatureCollection(markers) {
  return {
    type: "FeatureCollection",
    features: markers.map((marker) => ({
      type: "Feature",
      id: marker.id,
      geometry: {
        type: "Point",
        coordinates: [marker.longitude, marker.latitude],
      },
      properties: {
        ...marker,
        activityColor: normalizeActivityColor(marker.activityColor),
        daysSinceLastActivity:
          typeof marker.daysSinceLastActivity === "number" ? marker.daysSinceLastActivity : -1,
      },
    })),
  };
}

function getClusterColorExpression() {
  const averageAge = ["/", ["get", "activityAgeSum"], ["get", "activityAgeCount"]];

  return [
    "case",
    ["==", ["get", "activityAgeCount"], 0],
    UNKNOWN_ACTIVITY_COLOR,
    [">=", averageAge, ACTIVITY_THRESHOLD_DAYS],
    normalizeActivityColor(getActivityColor(ACTIVITY_THRESHOLD_DAYS)),
    [
      "interpolate",
      ["linear"],
      averageAge,
      0,
      normalizeActivityColor(getActivityColor(0)),
      Math.round(ACTIVITY_THRESHOLD_DAYS * 0.6),
      normalizeActivityColor(getActivityColor(Math.round(ACTIVITY_THRESHOLD_DAYS * 0.6))),
      Math.round(ACTIVITY_THRESHOLD_DAYS * 0.88),
      normalizeActivityColor(getActivityColor(Math.round(ACTIVITY_THRESHOLD_DAYS * 0.88))),
      ACTIVITY_THRESHOLD_DAYS,
      normalizeActivityColor(getActivityColor(ACTIVITY_THRESHOLD_DAYS)),
    ],
  ];
}

function normalizeActivityColor(color) {
  if (typeof color !== "string") {
    return UNKNOWN_ACTIVITY_COLOR;
  }

  const trimmedColor = color.trim();

  if (/^#[0-9a-f]{6}$/i.test(trimmedColor)) {
    return trimmedColor;
  }

  const hslMatch = trimmedColor.match(/^hsl\(\s*(-?\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%\s*\)$/i);

  if (!hslMatch) {
    return UNKNOWN_ACTIVITY_COLOR;
  }

  return hslToHex(Number(hslMatch[1]), Number(hslMatch[2]), Number(hslMatch[3]));
}

function hslToHex(hue, saturation, lightness) {
  if (![hue, saturation, lightness].every(Number.isFinite)) {
    return UNKNOWN_ACTIVITY_COLOR;
  }

  const normalizedHue = (((hue % 360) + 360) % 360) / 360;
  const normalizedSaturation = Math.min(Math.max(saturation, 0), 100) / 100;
  const normalizedLightness = Math.min(Math.max(lightness, 0), 100) / 100;

  const hueToRgb = (p, q, t) => {
    let adjustedT = t;

    if (adjustedT < 0) adjustedT += 1;
    if (adjustedT > 1) adjustedT -= 1;
    if (adjustedT < 1 / 6) return p + (q - p) * 6 * adjustedT;
    if (adjustedT < 1 / 2) return q;
    if (adjustedT < 2 / 3) return p + (q - p) * (2 / 3 - adjustedT) * 6;

    return p;
  };

  const q =
    normalizedLightness < 0.5
      ? normalizedLightness * (1 + normalizedSaturation)
      : normalizedLightness + normalizedSaturation - normalizedLightness * normalizedSaturation;
  const p = 2 * normalizedLightness - q;
  const red = hueToRgb(p, q, normalizedHue + 1 / 3);
  const green = hueToRgb(p, q, normalizedHue);
  const blue = hueToRgb(p, q, normalizedHue - 1 / 3);

  return `#${[red, green, blue]
    .map((channel) =>
      Math.round(channel * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function createPopupContent(markerData) {
  const container = document.createElement("div");
  container.className = "marker-popup";

  const company = document.createElement("strong");
  company.textContent = markerData.companyName || markerData.company || "Unnamed company";
  container.append(company);

  const details = [
    ["Contact", [markerData.firstName, markerData.lastName].filter(Boolean).join(" ")],
    ["Phone", markerData.phone],
    ["Address", markerData.addressLabel],
    ["Created Date", markerData.createdDate],
    ["Last Activity", markerData.lastActivity],
    ["Elapsed Days", formatDaysSinceLastActivity(markerData.daysSinceLastActivity)],
    ["Suspect ID", markerData.suspectId],
  ];

  details.forEach(([label, value]) => {
    const row = document.createElement("div");
    row.className = "popup-detail";

    const labelElement = document.createElement("span");
    labelElement.textContent = label;

    const valueElement = document.createElement("b");
    valueElement.textContent = value || "Not provided";

    row.append(labelElement, valueElement);
    container.append(row);
  });

  return container;
}

function formatDaysSinceLastActivity(daysSinceLastActivity) {
  if (typeof daysSinceLastActivity !== "number" || daysSinceLastActivity < 0) {
    return "Unknown";
  }

  return `${daysSinceLastActivity} day${daysSinceLastActivity === 1 ? "" : "s"}`;
}
