// The status bar at the foot of a board card (Video board, and the Photo QC
// board since Nov 6 2026): the card's stage as a menu, the others as
// "Move to ...". The caller saves the change.
export function StageSelect<K extends string>({ value, stages, name, onChange }: { value: K; stages: readonly { key: K; label: string }[]; name: string; onChange: (next: K) => void }) {
  return (
    <label className="vb-card__move">
      <span className="sr-only">Move {name} to</span>
      <select value={value} onChange={(e) => onChange(e.target.value as K)} aria-label={`Move ${name} to`}>
        {stages.map((x) => (
          <option key={x.key} value={x.key}>
            {x.key === value ? x.label : `Move to ${x.label}`}
          </option>
        ))}
      </select>
    </label>
  );
}
