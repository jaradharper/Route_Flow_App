import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import { parseSalesforceCsv } from "./csv.js";
import { formatAddress, geocodeAddress } from "./geocoding.js";

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN || "";
const INITIAL_CENTER = [-98.5795, 39.8283];
const INITIAL_ZOOM = 3;

mapboxgl.accessToken = MAPBOX_TOKEN;

export default function App() {
  const fileInputRef = useRef(null);
  const [locations, setLocations] = useState([]);
  const [status, setStatus] = useState("Drop a Salesforce CSV to map addresses.");
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState("");

  const markerData = useMemo(
    () =>
      locations.map((location) => ({
        ...location,
        addressLabel: formatAddress(location),
      })),
    [locations],
  );

  const handleFiles = useCallback(async (files) => {
    const file = files?.[0];

    if (!file) {
      return;
    }

    setError("");
    setStatus(`Parsing ${file.name}...`);

    try {
      const records = await parseSalesforceCsv(file);
      const geocoded = await Promise.all(
        records.map(async (record, index) => {
          const coordinates = await geocodeAddress(record, index);
          return coordinates ? { id: `${record.company}-${index}`, ...record, ...coordinates } : null;
        }),
      );

      const nextLocations = geocoded.filter(Boolean);
      setLocations(nextLocations);
      setStatus(
        nextLocations.length
          ? `Mapped ${nextLocations.length} address${nextLocations.length === 1 ? "" : "es"}.`
          : "No usable addresses were found in that CSV.",
      );
    } catch (parseError) {
      setLocations([]);
      setError(parseError.message || "Unable to parse that CSV.");
      setStatus("Upload failed.");
    }
  }, []);

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

        <AddressList locations={locations} />
      </section>

      <MapView markers={markerData} />
    </main>
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
          <strong>{location.company || "Unnamed company"}</strong>
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
  const markersRef = useRef([]);

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
  }, []);

  useEffect(() => {
    const map = mapRef.current;

    if (!map) {
      return;
    }

    markersRef.current.forEach((marker) => marker.remove());
    markersRef.current = markers.map((markerData) =>
      new mapboxgl.Marker({ color: "#2563eb" })
        .setLngLat([markerData.longitude, markerData.latitude])
        .setPopup(new mapboxgl.Popup({ offset: 24 }).setDOMContent(createPopupContent(markerData)))
        .addTo(map),
    );

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
  }, [markers]);

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

function createPopupContent(markerData) {
  const container = document.createElement("div");
  container.className = "marker-popup";

  const company = document.createElement("strong");
  company.textContent = markerData.company || "Unnamed company";
  container.append(company);

  const address = document.createElement("span");
  address.textContent = markerData.addressLabel;
  container.append(address);

  return container;
}
