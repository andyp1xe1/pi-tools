export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function startOfWeek(date: Date): Date {
  const start = startOfDay(date);
  const day = start.getDay() || 7;
  start.setDate(start.getDate() - day + 1);
  return start;
}

export function endOfWeek(date: Date): Date {
  const end = startOfWeek(date);
  end.setDate(end.getDate() + 6);
  return end;
}

export function buildWeekDays(reference = new Date()): Array<{ index: number; label: string }> {
  const monday = startOfWeek(reference);
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(monday);
    date.setDate(monday.getDate() + index);
    return { index: index + 1, label: formatDayLabel(date) };
  });
}

export function weekLabel(reference = new Date()): string {
  const monday = startOfWeek(reference);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const month = new Intl.DateTimeFormat("en", { month: "long" }).format(monday);
  return `${monday.getDate()}–${sunday.getDate()} ${month} ${monday.getFullYear()}`;
}

export function formatDayLabel(date: Date): string {
  const weekday = new Intl.DateTimeFormat("en", { weekday: "long" }).format(date).padEnd(10);
  const month = new Intl.DateTimeFormat("en", { month: "long" }).format(date);
  return `${weekday} ${date.getDate()} ${month} ${date.getFullYear()}`;
}

export function dayIndexForDate(date: Date, reference = new Date()): number | undefined {
  const monday = startOfWeek(reference);
  const diff = Math.floor((startOfDay(date).getTime() - monday.getTime()) / 86_400_000);
  return diff >= 0 && diff < 7 ? diff + 1 : undefined;
}

export function timeToMinutes(time: string): number {
  const [hour = "0", minute = "0"] = time.split(":");
  return Number(hour) * 60 + Number(minute);
}
