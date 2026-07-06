import Papa from "papaparse";

const FIELD_ALIASES = {
  company: ["Company", "Company / Account", "Company/Account", "Account", "Account Name", "Name"],
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

        resolve(data.map(normalizeRecord).filter(hasAddress));
      },
      error: (error) => reject(error),
    });
  });
}

function normalizeRecord(row) {
  return {
    company: readAliasedField(row, FIELD_ALIASES.company),
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

function hasAddress(record) {
  return record.street || record.city || record.state || record.postalCode;
}
