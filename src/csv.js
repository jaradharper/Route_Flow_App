import Papa from "papaparse";

const FIELD_ALIASES = {
  company: ["Company", "Company / Account", "Company/Account", "Account", "Account Name", "Name"],
  firstName: ["First Name", "FirstName"],
  lastName: ["Last Name", "LastName"],
  phone: ["Phone", "Phone Number", "Telephone"],
  lastActivity: ["Last Activity", "LastActivity"],
  createdDate: ["Created Date", "CreatedDate", "Created"],
  suspectId: ["Suspect ID", "Suspect Id", "SuspectID"],
  suspectOwner: ["Suspect Owner", "Owner"],
  street: ["Street", "Billing Street", "Mailing Street", "Address"],
  city: ["City", "Billing City", "Mailing City"],
  state: ["State", "Billing State", "Mailing State", "State/Province"],
  postalCode: [
    "Postal Code",
    "Zip",
    "ZIP",
    "Zip/Postal Code",
    "Zip / Postal Code",
    "Billing Zip/Postal Code",
    "Mailing Zip/Postal Code",
  ],
};

export function parseSalesforceCsv(file) {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (header) => header.trim(),
      complete: ({ data, errors }) => {
        const fatalError = errors.find((error) => error.type !== "FieldMismatch");

        if (fatalError) {
          reject(new Error(fatalError.message));
          return;
        }

        resolve(dedupeRecords(data.map(normalizeRecord).filter(hasAddress)));
      },
      error: (error) => reject(error),
    });
  });
}

function normalizeRecord(row) {
  const companyName = readAliasedField(row, FIELD_ALIASES.company);

  return {
    companyName,
    company: companyName,
    firstName: readAliasedField(row, FIELD_ALIASES.firstName),
    lastName: readAliasedField(row, FIELD_ALIASES.lastName),
    phone: readAliasedField(row, FIELD_ALIASES.phone),
    lastActivity: readAliasedField(row, FIELD_ALIASES.lastActivity),
    createdDate: readAliasedField(row, FIELD_ALIASES.createdDate),
    suspectId: readAliasedField(row, FIELD_ALIASES.suspectId),
    suspectOwner: readAliasedField(row, FIELD_ALIASES.suspectOwner),
    street: readAliasedField(row, FIELD_ALIASES.street),
    city: readAliasedField(row, FIELD_ALIASES.city),
    state: readAliasedField(row, FIELD_ALIASES.state),
    postalCode: readAliasedField(row, FIELD_ALIASES.postalCode),
  };
}

function readAliasedField(row, aliases) {
  const normalizedAliases = aliases.map(normalizeHeader);
  const key = Object.keys(row).find((header) => normalizedAliases.includes(normalizeHeader(header)));
  return key ? String(row[key] ?? "").trim() : "";
}

function normalizeHeader(header) {
  return String(header)
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "");
}

function dedupeRecords(records) {
  return Array.from(
    records
      .reduce((dedupedRecords, record) => {
        const key = normalizeRecordKey(record);
        const existingRecord = dedupedRecords.get(key);

        if (!existingRecord || isMoreRecentlyUpdated(record, existingRecord)) {
          dedupedRecords.set(key, record);
        }

        return dedupedRecords;
      }, new Map())
      .values(),
  );
}

export function normalizeRecordKey(record) {
  if (record.suspectId) {
    return `suspect:${normalizeText(record.suspectId)}`;
  }

  return `address:${normalizeText(record.companyName)}:${normalizeText(
    [record.street, record.city, record.state, record.postalCode].filter(Boolean).join(" "),
  )}`;
}

function isMoreRecentlyUpdated(nextRecord, currentRecord) {
  return getRecordTimestamp(nextRecord) > getRecordTimestamp(currentRecord);
}

function getRecordTimestamp(record) {
  return parseDateTimestamp(record.lastActivity) || parseDateTimestamp(record.createdDate);
}

function parseDateTimestamp(value) {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function normalizeText(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ");
}

function hasAddress(record) {
  return record.street || record.city || record.state || record.postalCode;
}
