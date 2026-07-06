export const ACTIVITY_THRESHOLD_DAYS = 45;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const RECENT_GREEN = { hue: 145, saturation: 66, lightness: 43 };
const WARNING_YELLOW = { hue: 48, saturation: 93, lightness: 50 };
const WARNING_ORANGE = { hue: 25, saturation: 90, lightness: 52 };
const OVERDUE_RED = "#dc2626";
const UNKNOWN_GRAY = "#6b7280";

export function calculateDaysSinceLastActivity(lastActivity, today = new Date()) {
  const activityDate = parseActivityDate(lastActivity);

  if (!activityDate) {
    return null;
  }

  const todayStart = startOfDay(today);
  const activityStart = startOfDay(activityDate);
  const daysSinceActivity = Math.floor((todayStart.getTime() - activityStart.getTime()) / MS_PER_DAY);

  return Math.max(0, daysSinceActivity);
}

export function getActivityColor(daysSinceLastActivity) {
  if (typeof daysSinceLastActivity !== "number") {
    return UNKNOWN_GRAY;
  }

  if (daysSinceLastActivity >= ACTIVITY_THRESHOLD_DAYS) {
    return OVERDUE_RED;
  }

  const progress = daysSinceLastActivity / ACTIVITY_THRESHOLD_DAYS;

  if (progress < 0.6) {
    return interpolateHsl(RECENT_GREEN, WARNING_YELLOW, progress / 0.6);
  }

  return interpolateHsl(WARNING_YELLOW, WARNING_ORANGE, (progress - 0.6) / 0.4);
}

export function shouldPulseMarker(daysSinceLastActivity) {
  return (
    typeof daysSinceLastActivity === "number" && daysSinceLastActivity >= ACTIVITY_THRESHOLD_DAYS
  );
}

function parseActivityDate(value) {
  if (!value) {
    return null;
  }

  const parsedDate = new Date(value);
  return Number.isNaN(parsedDate.getTime()) ? null : parsedDate;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function interpolateHsl(start, end, amount) {
  const hue = Math.round(start.hue + (end.hue - start.hue) * amount);
  const saturation = Math.round(start.saturation + (end.saturation - start.saturation) * amount);
  const lightness = Math.round(start.lightness + (end.lightness - start.lightness) * amount);

  return `hsl(${hue} ${saturation}% ${lightness}%)`;
}
