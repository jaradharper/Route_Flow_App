# Salesforce Address Mapper

React + Vite app for uploading a Salesforce CSV export and displaying company addresses on a Mapbox GL JS map.

## Run locally

1. Install dependencies:

   ```bash
   npm install
   ```

2. Add your Mapbox token:

   ```bash
   cp .env.example .env
   ```

   Then replace `your_mapbox_access_token_here` with a valid Mapbox access token.

3. Start the app:

   ```bash
   npm run dev
   ```

## CSV columns

The parser expects Salesforce-style columns for:

- `Company`
- `Street`
- `City`
- `State`
- `Postal Code`

Several common Salesforce aliases are also accepted, such as `Account Name`, `Billing Street`, and `Billing City`.

## Geocoding

Real geocoding is intentionally isolated in `src/geocoding.js`. The current `geocodeAddress` function returns deterministic placeholder coordinates so the map flow can be tested without a geocoding API.
