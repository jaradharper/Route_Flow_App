import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import {
  ACTIVITY_THRESHOLD_DAYS,
  calculateDaysSinceLastActivity,
  getActivityColor,
  shouldPulseMarker,
} from "./activity.js";
import { normalizeRecordKey, parseSalesforceCsv } from "./csv.js";
import { formatAddress, geocodeAddress, geocodeSearchAddress } from "./geocoding.js";

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
const ACCOUNT_CLASSIFICATION_STORAGE_KEY = "routeflow-account-classifications";
const ACCOUNT_CLASSIFICATION_OPTIONS = [
  { value: "privately-owned", label: "Privately owned" },
  { value: "property-managed-tenant-hvac", label: "Property managed (tenant responsible for HVAC)" },
  { value: "property-managed-management-hvac", label: "Property managed (management responsible for HVAC)" },
  { value: "corporate-level", label: "Corporate level" },
];
const ACCOUNT_CLASSIFICATION_LABELS = Object.fromEntries(
  ACCOUNT_CLASSIFICATION_OPTIONS.map((option) => [option.value, option.label]),
);

mapboxgl.accessToken = MAPBOX_TOKEN;

export default function App() {
  const fileInputRef = useRef(null);
  const [locations, setLocations] = useState([]);
  const [, setStatus] = useState("Drop a Salesforce CSV to map addresses.");
  const [isDragging, setIsDragging] = useState(false);
  const [, setError] = useState("");
  const [isProspectsOpen, setIsProspectsOpen] = useState(false);
  const [selectedProspectId, setSelectedProspectId] = useState(null);
  const [accountClassifications, setAccountClassifications] = useState(readStoredAccountClassifications);
  const [searchAddress, setSearchAddress] = useState("");
  const [searchedLocation, setSearchedLocation] = useState(null);
  const [isSearchingAddress, setIsSearchingAddress] = useState(false);
  const [currentLocation, setCurrentLocation] = useState(null);
  const [locationMessage, setLocationMessage] = useState("");

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
  const hasLoadedCsv = locations.length > 0;
  const selectedProspect = useMemo(
    () => markerData.find((prospect) => getProspectKey(prospect) === selectedProspectId) || null,
    [markerData, selectedProspectId],
  );

  useEffect(() => {
    writeStoredAccountClassifications(accountClassifications);
  }, [accountClassifications]);

  const handleClassificationChange = useCallback((prospectKey, value) => {
    if (!prospectKey) {
      return;
    }

    setAccountClassifications((currentClassifications) => {
      const nextClassifications = { ...currentClassifications };

      if (isValidAccountClassification(value)) {
        nextClassifications[prospectKey] = value;
      } else {
        delete nextClassifications[prospectKey];
      }

      return nextClassifications;
    });
  }, []);

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
      setError(parseError.message || "Unable to parse that CSV.");
      setStatus("Upload failed.");
    }
  }, []);

  useEffect(() => {
    if (!hasLoadedCsv) {
      setIsProspectsOpen(false);
      setSelectedProspectId(null);
    }
  }, [hasLoadedCsv]);

  useEffect(() => {
    if (selectedProspectId && !selectedProspect) {
      setSelectedProspectId(null);
    }
  }, [selectedProspect, selectedProspectId]);

  useEffect(() => {
    if (!selectedProspectId) {
      return undefined;
    }

    const handleDocumentKeyDown = (event) => {
      if (event.key === "Escape") {
        setSelectedProspectId(null);
      }
    };

    document.addEventListener("keydown", handleDocumentKeyDown);

    return () => {
      document.removeEventListener("keydown", handleDocumentKeyDown);
    };
  }, [selectedProspectId]);

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

  useEffect(() => {
    if (!navigator.geolocation) {
      setLocationMessage("Current location is unavailable in this browser.");
      return undefined;
    }

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        setCurrentLocation({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
        });
        setLocationMessage("");
      },
      (locationError) => {
        setLocationMessage(
          locationError.code === locationError.PERMISSION_DENIED
            ? "Current location permission was denied."
            : "Current location is unavailable right now.",
        );
      },
      {
        enableHighAccuracy: true,
        maximumAge: 15000,
        timeout: 12000,
      },
    );

    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  const searchMapAddress = async (event) => {
    event.preventDefault();
    const query = searchAddress.trim();

    if (!query) {
      return;
    }

    setError("");
    setIsSearchingAddress(true);
    setStatus(`Searching for ${query}...`);

    try {
      const nextLocation = await geocodeSearchAddress(query);

      if (!nextLocation) {
        setSearchedLocation(null);
        setError("Mapbox could not find that address. Try a more specific location.");
        setStatus("Address search failed.");
        return;
      }

      setSearchedLocation(nextLocation);
      setStatus(`Showing searched address: ${nextLocation.label}`);
    } catch {
      setSearchedLocation(null);
      setError("Unable to search for that address right now.");
      setStatus("Address search failed.");
    } finally {
      setIsSearchingAddress(false);
    }
  };

  const openCsvPicker = () => {
    fileInputRef.current?.click();
  };

  const toggleProspectsOpen = () => {
    setIsProspectsOpen((isOpen) => {
      if (isOpen) {
        setSelectedProspectId(null);
      }

      return !isOpen;
    });
  };

  return (
    <main className={`app-shell ${hasLoadedCsv ? "app-shell--active" : "app-shell--initial"}`}>
      <input
        ref={fileInputRef}
        className="file-input"
        type="file"
        accept=".csv,text/csv"
        onChange={(event) => {
          handleFiles(event.target.files);
          event.target.value = "";
        }}
      />

      <section className="control-panel" aria-label="Prospect controls">
        <h1 className="app-title">PROSPECT DROP MAPPER</h1>

        {!hasLoadedCsv ? (
          <CsvDropZone
            isDragging={isDragging}
            onDragStateChange={setIsDragging}
            onFilesSelected={handleFiles}
            onOpenFilePicker={openCsvPicker}
          />
        ) : (
          <ProspectsPanel
            prospects={markerData}
            isOpen={isProspectsOpen}
            selectedProspectId={selectedProspectId}
            accountClassifications={accountClassifications}
            onToggleOpen={toggleProspectsOpen}
            onToggleProspect={(prospectId) =>
              setSelectedProspectId((currentId) => (currentId === prospectId ? null : prospectId))
            }
          />
        )}
      </section>

      {selectedProspect ? (
        <ProspectDetailPanel
          prospect={selectedProspect}
          classification={accountClassifications[getProspectKey(selectedProspect)] || ""}
          onClassificationChange={(value) => handleClassificationChange(getProspectKey(selectedProspect), value)}
          onClose={() => setSelectedProspectId(null)}
        />
      ) : null}

      {hasLoadedCsv ? (
        <button type="button" className="csv-replace-button" onClick={openCsvPicker}>
          <span aria-hidden="true">⇧</span>
          Drop CSV file
        </button>
      ) : null}

      <MapView
        markers={markerData}
        hasLoadedCsv={hasLoadedCsv}
        accountClassifications={accountClassifications}
        onClassificationChange={handleClassificationChange}
        searchAddress={searchAddress}
        searchedLocation={searchedLocation}
        isSearchingAddress={isSearchingAddress}
        currentLocation={currentLocation}
        locationMessage={locationMessage}
        onSearchAddressChange={setSearchAddress}
        onSearchAddress={searchMapAddress}
        onClearSearchedLocation={() => {
          setSearchedLocation(null);
          setStatus("Searched address cleared.");
        }}
      />
    </main>
  );
}

function CsvDropZone({ isDragging, onDragStateChange, onFilesSelected, onOpenFilePicker }) {
  return (
    <div
      className={`drop-zone${isDragging ? " is-dragging" : ""}`}
      onDragEnter={(event) => {
        event.preventDefault();
        onDragStateChange(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        event.preventDefault();
        onDragStateChange(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDragStateChange(false);
        onFilesSelected(event.dataTransfer.files);
      }}
      role="button"
      tabIndex={0}
      onClick={onOpenFilePicker}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpenFilePicker();
        }
      }}
    >
      <span className="drop-zone__icon" aria-hidden="true">⇧</span>
      <strong>Drop CSV file here</strong>
      <span>Required columns: Company, Street, City, State, Postal Code</span>
    </div>
  );
}

function ProspectsPanel({
  prospects,
  isOpen,
  selectedProspectId,
  accountClassifications,
  onToggleOpen,
  onToggleProspect,
}) {
  return (
    <section className={`prospects-panel${isOpen ? " prospects-panel--open" : ""}`}>
      <button
        type="button"
        className="prospects-tab"
        onClick={onToggleOpen}
        aria-expanded={isOpen}
        aria-controls="prospects-list"
      >
        <span className="prospects-tab__icon" aria-hidden="true">●●</span>
        <span>Prospects</span>
        <b>{prospects.length}</b>
        <span className="prospects-tab__chevron" aria-hidden="true">⌄</span>
      </button>

      <div
        id="prospects-list"
        className="prospect-list"
        aria-label="Loaded prospects"
        aria-hidden={!isOpen}
      >
        {prospects.map((prospect, index) => {
          const prospectKey = getProspectKey(prospect);
          const isSelected = selectedProspectId === prospectKey;
          const classificationLabel = getAccountClassificationLabel(accountClassifications[prospectKey]);

          return (
            <button
              type="button"
              key={prospectKey}
              className={`prospect-card${isSelected ? " prospect-card--selected" : ""}`}
              style={{
                "--prospect-index": index,
                "--prospect-reverse-index": Math.max(prospects.length - index - 1, 0),
              }}
              onClick={() => onToggleProspect(prospectKey)}
              aria-pressed={isSelected}
              tabIndex={isOpen ? 0 : -1}
            >
              <span
                className="prospect-card__activity"
                style={{ background: normalizeActivityColor(prospect.activityColor) }}
                aria-hidden="true"
              />
              <span className="prospect-card__summary">
                <strong>{prospect.companyName || prospect.company || "Unnamed company"}</strong>
                <small>{prospect.addressLabel || formatAddress(prospect) || "Address not provided"}</small>
                {classificationLabel ? <em>{classificationLabel}</em> : null}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function ProspectDetailPanel({ prospect, classification, onClassificationChange, onClose }) {
  const detailRows = createProspectDetailRows(prospect);
  const contactName = [prospect.firstName, prospect.lastName].filter(Boolean).join(" ");

  return (
    <aside className="prospect-detail-panel" aria-label="Selected prospect details">
      <button type="button" className="prospect-detail-close" onClick={onClose} aria-label="Close prospect details">
        ×
      </button>
      <div className="prospect-detail-heading">
        <strong>{prospect.companyName || prospect.company || "Unnamed company"}</strong>
        {contactName ? <span>{contactName}</span> : null}
      </div>
      <AccountClassificationSelect
        id={`classification-${getProspectKey(prospect)}`}
        value={classification}
        onChange={onClassificationChange}
      />
      <div className="prospect-detail-fields">
        {detailRows.map(([label, value]) => (
          <div className="prospect-detail-row" key={label}>
            <span>{label}</span>
            <b>{value || "Not provided"}</b>
          </div>
        ))}
      </div>
    </aside>
  );
}

function AccountClassificationSelect({ id, value, onChange }) {
  const wrapperRef = useRef(null);
  const buttonRef = useRef(null);
  const savedTimeoutRef = useRef(null);
  const [isOpen, setIsOpen] = useState(false);
  const [isSaved, setIsSaved] = useState(false);
  const selectedLabel = getAccountClassificationLabel(value) || "Select type";

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    const handlePointerDown = (event) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        setIsOpen(false);
        buttonRef.current?.focus();
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  useEffect(() => () => {
    if (savedTimeoutRef.current) {
      window.clearTimeout(savedTimeoutRef.current);
    }
  }, []);

  const selectValue = (nextValue) => {
    onChange(nextValue);
    setIsOpen(false);
    setIsSaved(true);
    buttonRef.current?.blur();

    if (savedTimeoutRef.current) {
      window.clearTimeout(savedTimeoutRef.current);
    }

    savedTimeoutRef.current = window.setTimeout(() => setIsSaved(false), 750);
  };

  const handleButtonKeyDown = (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setIsOpen(true);
    }

    if ((event.key === "Enter" || event.key === " ") && !isOpen) {
      event.preventDefault();
      setIsOpen(true);
    }
  };

  return (
    <div className="account-classification-select" ref={wrapperRef}>
      <span id={`${id}-label`}>Account type</span>
      <button
        ref={buttonRef}
        id={id}
        type="button"
        className={`account-type-control${isSaved ? " account-type-control--saved" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-labelledby={`${id}-label ${id}`}
        onClick={() => setIsOpen((open) => !open)}
        onKeyDown={handleButtonKeyDown}
      >
        <span>{selectedLabel}</span>
        {isSaved ? <b aria-hidden="true">Saved</b> : null}
        <i aria-hidden="true">⌄</i>
      </button>

      {isOpen ? (
        <div className="account-type-menu" role="listbox" aria-labelledby={`${id}-label`}>
          <button
            type="button"
            role="option"
            aria-selected={!value}
            className={!value ? "is-selected" : ""}
            onClick={() => selectValue("")}
          >
            Select type
          </button>
          {ACCOUNT_CLASSIFICATION_OPTIONS.map((option) => (
            <button
              type="button"
              role="option"
              key={option.value}
              aria-selected={value === option.value}
              className={value === option.value ? "is-selected" : ""}
              onClick={() => selectValue(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function MapView({
  markers,
  hasLoadedCsv,
  accountClassifications,
  onClassificationChange,
  searchAddress,
  searchedLocation,
  isSearchingAddress,
  currentLocation,
  locationMessage,
  onSearchAddressChange,
  onSearchAddress,
  onClearSearchedLocation,
}) {
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const popupRef = useRef(null);
  const pulseFrameRef = useRef(null);
  const searchedMarkerRef = useRef(null);
  const currentLocationMarkerRef = useRef(null);
  const navigationControlRef = useRef(null);
  const activeAccountPopupRef = useRef(null);
  const hasCenteredOnCurrentLocationRef = useRef(false);
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

    mapRef.current.on("load", () => setIsMapLoaded(true));
  }, []);

  useEffect(() => {
    const map = mapRef.current;

    if (!map || !isMapLoaded) {
      return;
    }

    if (hasLoadedCsv && !navigationControlRef.current) {
      navigationControlRef.current = new mapboxgl.NavigationControl();
      map.addControl(navigationControlRef.current, "top-right");
      return;
    }

    if (!hasLoadedCsv && navigationControlRef.current) {
      map.removeControl(navigationControlRef.current);
      navigationControlRef.current = null;
    }
  }, [hasLoadedCsv, isMapLoaded]);

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

      const prospectKey = getProspectKey(feature.properties);
      activeAccountPopupRef.current = {
        coordinates: feature.geometry.coordinates,
        prospect: feature.properties,
      };
      popupRef.current?.remove();
      popupRef.current = new mapboxgl.Popup({ offset: 14 })
        .setLngLat(feature.geometry.coordinates)
        .setDOMContent(
          createPopupContent(
            feature.properties,
            accountClassifications[prospectKey] || "",
            (value) => onClassificationChange(prospectKey, value),
          ),
        )
        .addTo(map);
      popupRef.current.on("close", () => {
        activeAccountPopupRef.current = null;
      });
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
  }, [accountClassifications, isMapLoaded, onClassificationChange]);

  useEffect(() => {
    const activePopup = activeAccountPopupRef.current;

    if (!popupRef.current || !activePopup) {
      return;
    }

    const prospectKey = getProspectKey(activePopup.prospect);
    popupRef.current.setDOMContent(
      createPopupContent(
        activePopup.prospect,
        accountClassifications[prospectKey] || "",
        (value) => onClassificationChange(prospectKey, value),
      ),
    );
  }, [accountClassifications, onClassificationChange]);

  useEffect(() => {
    const map = mapRef.current;

    if (!map || !isMapLoaded) {
      return undefined;
    }

    searchedMarkerRef.current?.remove();
    searchedMarkerRef.current = null;

    if (!searchedLocation) {
      return undefined;
    }

    searchedMarkerRef.current = new mapboxgl.Marker({ element: createSearchedAddressMarkerElement() })
      .setLngLat([searchedLocation.longitude, searchedLocation.latitude])
      .setPopup(new mapboxgl.Popup({ offset: 20 }).setDOMContent(createSearchedAddressPopup(searchedLocation)))
      .addTo(map);

    map.flyTo({
      center: [searchedLocation.longitude, searchedLocation.latitude],
      zoom: Math.max(map.getZoom(), 13),
      essential: true,
    });

    return () => {
      searchedMarkerRef.current?.remove();
      searchedMarkerRef.current = null;
    };
  }, [isMapLoaded, searchedLocation]);

  useEffect(() => {
    const map = mapRef.current;

    if (!map || !isMapLoaded) {
      return undefined;
    }

    currentLocationMarkerRef.current?.remove();
    currentLocationMarkerRef.current = null;

    if (!currentLocation) {
      return undefined;
    }

    currentLocationMarkerRef.current = new mapboxgl.Marker({
      element: createCurrentLocationMarkerElement(currentLocation),
    })
      .setLngLat([currentLocation.longitude, currentLocation.latitude])
      .setPopup(new mapboxgl.Popup({ offset: 18 }).setDOMContent(createCurrentLocationPopup(currentLocation)))
      .addTo(map);

    if (!hasCenteredOnCurrentLocationRef.current) {
      hasCenteredOnCurrentLocationRef.current = true;
      map.flyTo({
        center: [currentLocation.longitude, currentLocation.latitude],
        zoom: Math.max(map.getZoom(), 13),
        essential: true,
      });
    }

    return () => {
      currentLocationMarkerRef.current?.remove();
      currentLocationMarkerRef.current = null;
    };
  }, [currentLocation, isMapLoaded]);

  const centerOnCurrentLocation = () => {
    const map = mapRef.current;

    if (!map || !currentLocation) {
      return;
    }

    map.flyTo({
      center: [currentLocation.longitude, currentLocation.latitude],
      zoom: Math.max(map.getZoom(), 14),
      essential: true,
    });
  };

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

  return (
    <section className="map-shell">
      {!hasLoadedCsv ? <div className="map-dim-overlay" aria-hidden="true" /> : null}
      <form className="floating-address-search" onSubmit={onSearchAddress}>
        <input
          type="search"
          placeholder="Put any address here"
          value={searchAddress}
          onChange={(event) => onSearchAddressChange(event.target.value)}
          aria-label="Search any address"
        />
        <button type="submit" disabled={isSearchingAddress || !searchAddress.trim()}>
          {isSearchingAddress ? "Searching" : "Search"}
        </button>
        {searchedLocation ? (
          <button type="button" className="glass-clear-button" onClick={onClearSearchedLocation}>
            Clear
          </button>
        ) : null}
      </form>
      {hasLoadedCsv ? (
        <div className="location-overlay">
          {currentLocation ? (
            <button type="button" className="center-location-button" onClick={centerOnCurrentLocation}>
              Center on me
            </button>
          ) : null}
          {locationMessage ? <p className="location-message">{locationMessage}</p> : null}
        </div>
      ) : null}
      <section ref={setMapContainer} className="map-view" aria-label="Mapped Salesforce addresses" />
    </section>
  );
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
        prospectKey: getProspectKey(marker),
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


function createProspectDetailRows(prospect) {
  const baseRows = [
    ["Company / Account", prospect.companyName || prospect.company],
    ["Contact", [prospect.firstName, prospect.lastName].filter(Boolean).join(" ")],
    ["Street", prospect.street],
    ["City", prospect.city],
    ["State", prospect.state],
    ["Postal Code", prospect.postalCode],
    ["Phone", prospect.phone],
    ["Email", prospect.email],
    ["Last Activity", prospect.lastActivity],
    ["Created Date", prospect.createdDate],
    ["Suspect ID", prospect.suspectId],
    ["Suspect Owner", prospect.suspectOwner],
    ["Elapsed Days", formatDaysSinceLastActivity(prospect.daysSinceLastActivity)],
  ];
  const usedKeys = new Set([
    "id",
    "longitude",
    "latitude",
    "activityColor",
    "shouldPulse",
    "daysSinceLastActivity",
    "addressLabel",
    "company",
    "companyName",
    "firstName",
    "lastName",
    "street",
    "city",
    "state",
    "postalCode",
    "phone",
    "email",
    "lastActivity",
    "createdDate",
    "suspectId",
    "suspectOwner",
  ]);
  const extraRows = Object.entries(prospect)
    .filter(([key, value]) => !usedKeys.has(key) && value !== null && value !== undefined && String(value).trim())
    .map(([key, value]) => [formatDetailLabel(key), String(value)]);

  return [...baseRows, ...extraRows].filter(([, value]) => value !== null && value !== undefined && String(value).trim());
}

function formatDetailLabel(key) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function getProspectKey(prospect) {
  if (prospect?.suspectId) {
    return normalizeRecordKey(prospect);
  }

  return prospect?.id || prospect?.prospectKey || normalizeRecordKey(prospect || {});
}

function getAccountClassificationLabel(value) {
  return ACCOUNT_CLASSIFICATION_LABELS[value] || "";
}

function isValidAccountClassification(value) {
  return Object.prototype.hasOwnProperty.call(ACCOUNT_CLASSIFICATION_LABELS, value);
}

function readStoredAccountClassifications() {
  try {
    if (typeof window === "undefined") {
      return {};
    }

    const storedValue = window.localStorage?.getItem(ACCOUNT_CLASSIFICATION_STORAGE_KEY);

    if (!storedValue) {
      return {};
    }

    const parsedValue = JSON.parse(storedValue);

    if (!parsedValue || typeof parsedValue !== "object" || Array.isArray(parsedValue)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsedValue).filter(
        ([key, value]) => typeof key === "string" && isValidAccountClassification(value),
      ),
    );
  } catch {
    return {};
  }
}

function writeStoredAccountClassifications(classifications) {
  try {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage?.setItem(ACCOUNT_CLASSIFICATION_STORAGE_KEY, JSON.stringify(classifications));
  } catch {
    // Local persistence is optional; the in-memory selection still works if storage is blocked.
  }
}

function createAccountClassificationSelectElement(classification, onClassificationChange) {
  const label = document.createElement("label");
  label.className = "account-classification-select marker-classification-select";

  const labelText = document.createElement("span");
  labelText.textContent = "Account type";

  const select = document.createElement("select");

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select type";
  select.append(placeholder);

  ACCOUNT_CLASSIFICATION_OPTIONS.forEach((option) => {
    const optionElement = document.createElement("option");
    optionElement.value = option.value;
    optionElement.textContent = option.label;
    select.append(optionElement);
  });

  select.value = isValidAccountClassification(classification) ? classification : "";

  select.addEventListener("change", (event) => {
    onClassificationChange(event.target.value);
  });

  label.append(labelText, select);
  return label;
}

function createPopupContent(markerData, classification, onClassificationChange) {
  const container = document.createElement("div");
  container.className = "marker-popup";

  const company = document.createElement("strong");
  company.textContent = markerData.companyName || markerData.company || "Unnamed company";
  container.append(company);
  container.append(createAccountClassificationSelectElement(classification, onClassificationChange));

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

function createSearchedAddressMarkerElement() {
  const marker = document.createElement("button");
  marker.className = "searched-address-star";
  marker.type = "button";
  marker.textContent = "★";
  marker.setAttribute("aria-label", "Searched address");

  return marker;
}

function createSearchedAddressPopup(searchedLocation) {
  const container = document.createElement("div");
  container.className = "marker-popup searched-address-popup";

  const title = document.createElement("strong");
  title.textContent = "Searched address";
  container.append(title);

  const detail = document.createElement("div");
  detail.className = "popup-detail";

  const label = document.createElement("span");
  label.textContent = "Address";

  const value = document.createElement("b");
  value.textContent = searchedLocation.label || searchedLocation.query;

  detail.append(label, value);
  container.append(detail);

  return container;
}

function createCurrentLocationMarkerElement(currentLocation) {
  const marker = document.createElement("button");
  marker.className = "current-location-marker";
  marker.type = "button";
  marker.setAttribute("aria-label", "Your current location");

  if (typeof currentLocation.accuracy === "number") {
    marker.style.setProperty("--accuracy-size", `${Math.min(Math.max(currentLocation.accuracy / 3, 34), 96)}px`);
  }

  return marker;
}

function createCurrentLocationPopup(currentLocation) {
  const container = document.createElement("div");
  container.className = "marker-popup current-location-popup";

  const title = document.createElement("strong");
  title.textContent = "Your current location";
  container.append(title);

  if (typeof currentLocation.accuracy === "number") {
    const detail = document.createElement("div");
    detail.className = "popup-detail";

    const label = document.createElement("span");
    label.textContent = "Accuracy";

    const value = document.createElement("b");
    value.textContent = `Within ${Math.round(currentLocation.accuracy)} meters`;

    detail.append(label, value);
    container.append(detail);
  }

  return container;
}

function formatDaysSinceLastActivity(daysSinceLastActivity) {
  if (typeof daysSinceLastActivity !== "number" || daysSinceLastActivity < 0) {
    return "Unknown";
  }

  return `${daysSinceLastActivity} day${daysSinceLastActivity === 1 ? "" : "s"}`;
}
