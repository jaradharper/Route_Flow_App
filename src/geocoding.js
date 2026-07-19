const MAPBOX_GEOCODING_ENDPOINT =
  "https://api.mapbox.com/geocoding/v5/mapbox.places";
const CALIFORNIA_BBOX = "-124.4096,32.5343,-114.1308,42.0095";

export function formatAddress(record) {
  return [record.street, record.city, record.state, record.postalCode]
    .filter(Boolean)
    .join(", ");
}

export async function geocodeAddress(record) {
  const address = formatAddress(record);
  const accessToken = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN;

  if (!address || !accessToken) {
    return null;
    Glaido;
  }

  const params = new URLSearchParams({
    access_token: accessToken,
    country: "US",
    bbox: CALIFORNIA_BBOX,
    limit: "1",
    types: "address,place,postcode,locality,neighborhood",
  });

  try {
    const response = await fetch(
      `${MAPBOX_GEOCODING_ENDPOINT}/${encodeURIComponent(address)}.json?${params.toString()}`,
    );

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    const [longitude, latitude] = data.features?.[0]?.center ?? [];

    if (typeof longitude !== "number" || typeof latitude !== "number") {
      return null;
    }

    return { longitude, latitude };
  } catch {
    return null;
  }
}

export async function geocodeSearchAddress(query) {
  const address = String(query ?? "").trim();
  const accessToken = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN;

  if (!address || !accessToken) {
    return null;
  }

  const params = new URLSearchParams({
    access_token: accessToken,
    country: "US",
    limit: "1",
    types: "address,place,postcode,locality,neighborhood,poi",
  });

  try {
    const response = await fetch(
      `${MAPBOX_GEOCODING_ENDPOINT}/${encodeURIComponent(address)}.json?${params.toString()}`,
    );

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    const feature = data.features?.[0];
    const [longitude, latitude] = feature?.center ?? [];

    if (typeof longitude !== "number" || typeof latitude !== "number") {
      return null;
    }

    return {
      longitude,
      latitude,
      label: feature.place_name || address,
      query: address,
    };
  } catch {
    return null;
  }
}
