import { useId } from "react";

function codePoints(s: string): number {
  return [...s].length;
}

interface Props {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Maximum length in code points (the contract's limit); shows a counter. */
  max?: number;
  multiline?: boolean;
  hint?: string | undefined;
  placeholder?: string | undefined;
  error?: string | null | undefined;
  required?: boolean;
  wide?: boolean;
  inputMode?: "text" | "numeric";
  monospace?: boolean;
}

/** A labelled text field with a persistent label, a character counter and an error tied to the field. */
export function FormField({ label, value, onChange, max, multiline, hint, placeholder, error, required, wide, inputMode, monospace }: Props) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const count = codePoints(value);
  const describedBy = [hint ? hintId : null, max !== undefined ? `${id}-count` : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  const common = {
    id,
    value,
    placeholder,
    required,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy,
    className: monospace ? "mono" : undefined,
    onChange: (e: { target: { value: string } }) => onChange(e.target.value),
  };
  return (
    <div className={`field${wide || multiline ? " field--wide" : ""}`}>
      <label htmlFor={id}>
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </label>
      {hint ? (
        <span id={hintId} className="hint">
          {hint}
        </span>
      ) : null}
      {multiline ? <textarea {...common} /> : <input {...common} inputMode={inputMode} autoComplete="off" />}
      {max !== undefined ? (
        <span id={`${id}-count`} className="counter" aria-live="polite">
          {count} / {max}
          {count > max ? " (too long)" : ""}
        </span>
      ) : null}
      {error ? (
        <p id={errorId} className="field-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
