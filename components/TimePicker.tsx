"use client";

interface TimePickerProps {
  value: string;
  onChange: (time: string) => void;
  disabled?: boolean;
  id?: string;
}

/**
 * Half-hour slots across the full day.
 *
 * The previous version offered whole hours from 06:00 to 23:00 only, which
 * quietly made an early-morning briefing — arguably the most natural time to
 * want one — impossible to choose.
 */
const OPTIONS = Array.from({ length: 48 }, (_, i) => {
  const hour = Math.floor(i / 2);
  const minute = i % 2 === 0 ? "00" : "30";
  const value = `${String(hour).padStart(2, "0")}:${minute}`;
  const period = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return { value, label: `${hour12}:${minute} ${period}` };
});

export default function TimePicker({ value, onChange, disabled = false, id }: TimePickerProps) {
  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className="h-10 w-full rounded-lg border border-line bg-surface px-3 text-sm text-fg focus:border-accent focus:outline-none disabled:opacity-50"
    >
      {OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
