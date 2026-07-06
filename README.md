# RouteFlow

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

4. In a second terminal, start the local Salesforce backend:

   ```bash
   npm run server
   ```

## Salesforce refresh

RouteFlow can refresh from one configured Salesforce report through a local OAuth backend. The frontend never receives your Salesforce password, MFA code, client secret, or refresh token.

Create a Salesforce Connected App and configure its callback URL as:

```text
http://localhost:5174/api/salesforce/callback
```

Then add these values to your local `.env` file:

```bash
SALESFORCE_CLIENT_ID=
SALESFORCE_CLIENT_SECRET=
SALESFORCE_REDIRECT_URI=http://localhost:5174/api/salesforce/callback
SALESFORCE_LOGIN_URL=https://login.salesforce.com
SALESFORCE_REPORT_ID=
SALESFORCE_API_VERSION=v61.0
```

Use `https://test.salesforce.com` for `SALESFORCE_LOGIN_URL` if you are connecting to a sandbox.

Click **Connect Salesforce** in RouteFlow, complete Salesforce login, then click **Refresh from Salesforce**. The backend downloads report rows, converts them into CSV text, and sends them through the same parser and Mapbox geocoding flow used by manual CSV upload.

Salesforce admin approval may be required for Connected App access, API access, report visibility, or permissions such as `Run Reports` and `View Reports`.

The Salesforce Reports API can return up to the first 2,000 report rows for this MVP. If the RouteFlow report grows beyond that, use a later SOQL or Bulk API integration.

Local Salesforce OAuth token data is stored under `.routeflow/`, which is ignored by git.

## CSV columns

The parser expects Salesforce-style columns for:

- `Created Date`
- `Company / Account`
- `First Name`
- `Last Name`
- `Phone`
- `Last Activity`
- `Street`
- `City`
- `State/Province`
- `Zip/Postal Code`
- `Suspect ID`
- `Suspect Owner`

Several common aliases are also accepted, such as `Company`, `Account Name`, `State`, `Postal Code`, and `Zip`.

`Suspect ID` is used as the unique record key. If it is missing, RouteFlow falls back to normalized `Company / Account` plus the full address.

## Geocoding

Coordinate placement must always use verified Mapbox geocoding results. Never use placeholder, fake, random, hash-based, fallback, or deterministic coordinates.

Coordinate flow:

1. `src/csv.js` parses CSV rows and preserves `street`, `city`, `state`, and `postalCode`.
2. `src/geocoding.js` builds the full address and calls Mapbox geocoding.
3. `src/App.jsx` renders only records that receive real `{ longitude, latitude }` values from Mapbox.

Rows that cannot be geocoded are skipped instead of being placed on the map.

## Marker colors

Markers are small circular dots. Color is based on elapsed time from `Created Date` to `Last Activity`.
If `Last Activity` is missing, RouteFlow uses today's date as the effective last activity so old untouched suspects still age into red.

- 0 elapsed days is green.
- Elapsed days gradually shift green to yellow to orange as they approach 60 days.
- 60+ elapsed days is red.
- Missing/invalid `Created Date`, invalid `Last Activity`, or reversed dates are gray.
- Red overdue dots have a subtle pulse.

The revisit threshold is controlled by `ACTIVITY_THRESHOLD_DAYS` in `src/activity.js`.

## Clustering

When zoomed out, nearby dots cluster together using Mapbox source/layer clustering. Cluster color represents the average activity age of valid records inside the cluster:

- mostly recent records are green
- mixed records are yellow/orange
- mostly overdue records are red
- clusters with no valid activity dates are gray

Clusters split back into individual dots as you zoom in.

## Current MVP scope

RouteFlow imports Salesforce CSV files or refreshes from one Salesforce report, geocodes addresses through Mapbox, displays activity-colored dots on a satellite map, clusters dense areas, and shows account details in popups. It does not generate coordinates locally.
