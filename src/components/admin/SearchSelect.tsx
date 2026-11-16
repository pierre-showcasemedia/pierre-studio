"use client";
// A searchable picker for long lists: clients, listings, people (Oct 28 2026;
// the owner: "it defaults to this Apple menu, and it's impossible to search or
// properly select a client. The picker needs to allow us to better select
// or find clients instantly"). Replaces the native <select> wherever the
// list is a set of records; short fixed lists (status, sort, time) keep the
// native menu, which is the better wheel on an iPhone.
//
//   - Computer: a dropdown under the field with a search box on top. Typing
//     filters at once (name, company, email, any word in any order, accents
//     ignored); arrows move, Enter picks, Escape closes.
//   - Phone: the list opens full screen with the keyboard already up, rows
//     big enough for a thumb, Cancel at the top.
//
// It posts like the select it replaces: a field named `name` carries the
// value, so GET filters and server actions read it unchanged. `required`
// blocks the form like a select would. `submitOnPick` applies a filter form
// as soon as something is picked.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";

export type PickOption = { value: string; label: string; sub?: string | null; keywords?: string | null };

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export function SearchSelect({
  name,
  id,
  options,
  defaultValue = "",
  emptyLabel,
  placeholder = "Choose",
  title,
  searchPlaceholder = "Search",
  required = false,
  submitOnPick = false,
  ariaLabel,
}: {
  name: string;
  id?: string;
  options: PickOption[];
  defaultValue?: string;
  emptyLabel?: string; // an "all" or "nobody" choice at the top, value ""
  placeholder?: string; // shown while nothing is picked and there is no emptyLabel
  title?: string; // the phone sheet's heading, e.g. "Choose a client"
  searchPlaceholder?: string;
  required?: boolean;
  submitOnPick?: boolean;
  ariaLabel?: string;
}) {
  const auto = useId();
  const listId = `${auto}-list`;
  const [value, setValue] = useState(defaultValue);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  const all = useMemo<PickOption[]>(() => (emptyLabel != null ? [{ value: "", label: emptyLabel }, ...options] : options), [options, emptyLabel]);
  const hay = useMemo(() => all.map((o) => fold(`${o.label} ${o.sub ?? ""} ${o.keywords ?? ""}`)), [all]);
  const shown = useMemo(() => {
    const words = fold(query).split(/\s+/).filter(Boolean);
    if (!words.length) return all;
    // While searching, only real records (no "All clients" row).
    const hits = all.filter((o, i) => o.value !== "" && words.every((w) => hay[i].includes(w)));
    // Names that start with what was typed come first.
    const lead = fold(words[0]);
    return [...hits.filter((o) => fold(o.label).startsWith(lead)), ...hits.filter((o) => !fold(o.label).startsWith(lead))];
  }, [all, hay, query]);
  const picked = all.find((o) => o.value === value) ?? null;

  const show = (seed = "") => {
    // flushSync keeps the focus inside the tap, so an iPhone raises the keyboard.
    flushSync(() => {
      setQuery(seed);
      setActive(Math.max(0, all.findIndex((o) => o.value === value)));
      setOpen(true);
    });
    input.current?.focus();
  };
  const hide = (refocus = true) => {
    setOpen(false);
    if (refocus) btn.current?.focus();
  };
  const pick = (o: PickOption) => {
    flushSync(() => {
      setValue(o.value);
      setOpen(false);
    });
    btn.current?.focus();
    field.current?.setCustomValidity("");
    if (submitOnPick && o.value !== value) field.current?.form?.requestSubmit();
  };

  // A tap or click outside closes it; on a phone the page behind stays still.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) hide(false);
    };
    document.addEventListener("pointerdown", onDown);
    const phone = window.matchMedia("(max-width: 759px)").matches;
    if (phone) document.documentElement.classList.add("ss-lock");
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.documentElement.classList.remove("ss-lock");
    };
  }, [open]);

  // Keep the highlighted row in view while the arrows move it.
  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(shown.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const o = shown[active];
      if (o) pick(o);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      hide();
    } else if (e.key === "Tab") {
      hide(false);
    }
  };

  return (
    <div ref={wrap} className={`ss${open ? " is-open" : ""}`}>
      {/* The value the form posts; required stops the form like a select would. */}
      <input
        ref={field}
        className="ss-field"
        name={name}
        value={value}
        required={required}
        tabIndex={-1}
        aria-hidden
        onChange={() => {}}
        onInvalid={(e) => {
          e.preventDefault();
          e.currentTarget.setCustomValidity("Choose one.");
          show();
        }}
      />
      <button
        ref={btn}
        id={id}
        type="button"
        className={`ss-btn${picked && picked.value !== "" ? "" : " is-empty"}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => (open ? hide() : show())}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            show();
          } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
            e.preventDefault();
            show(e.key); // start typing to search
          }
        }}
      >
        <span className="ss-btn__label">{picked ? picked.label : placeholder}</span>
        {picked?.sub && picked.value !== "" && <span className="ss-btn__sub">{picked.sub}</span>}
      </button>

      {open && (
        <div className="ss-panel" role="dialog" aria-label={title ?? ariaLabel ?? "Choose"}>
          <div className="ss-head">
            <span className="ss-title">{title ?? ariaLabel ?? "Choose"}</span>
            <button type="button" className="ss-cancel" onClick={() => hide()}>Cancel</button>
          </div>
          <div className="ss-search">
            <svg viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round"><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></svg>
            <input
              ref={input}
              type="search"
              enterKeyHint="go"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder={searchPlaceholder}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onKey}
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-activedescendant={shown[active] ? `${listId}-${active}` : undefined}
              aria-autocomplete="list"
            />
            {query && (
              <button type="button" className="ss-clear" aria-label="Clear the search" onClick={() => { setQuery(""); setActive(0); input.current?.focus(); }}>
                <svg viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round"><path d="M7 7l10 10M17 7L7 17" /></svg>
              </button>
            )}
          </div>
          <ul ref={list} id={listId} className="ss-list" role="listbox" aria-label={title ?? ariaLabel ?? "Choose"}>
            {shown.length === 0 && <li className="ss-none">Nothing matches &ldquo;{query}&rdquo;</li>}
            {shown.map((o, i) => (
              <li
                key={o.value || "__empty"}
                id={`${listId}-${i}`}
                data-i={i}
                role="option"
                aria-selected={o.value === value}
                className={`ss-opt${i === active ? " is-active" : ""}${o.value === value ? " is-picked" : ""}${o.value === "" ? " is-all" : ""}`}
                onPointerMove={() => setActive(i)}
                onClick={() => pick(o)}
              >
                <span className="ss-opt__text">
                  <span className="ss-opt__label">{o.label}</span>
                  {o.sub && <span className="ss-opt__sub">{o.sub}</span>}
                </span>
                {o.value === value && (
                  <svg className="ss-opt__tick" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.2 4.2L19 7" /></svg>
                )}
              </li>
            ))}
          </ul>
          {query && shown.length > 0 && <div className="ss-count">{shown.length} of {options.length}</div>}
        </div>
      )}
    </div>
  );
}
